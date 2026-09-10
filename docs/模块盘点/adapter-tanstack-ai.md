# 模块盘点：`@reins/adapter-tanstack-ai`

> 对应任务 B10。包版本 `0.1.0`，依赖 `@reins/core`（workspace）、`@standard-schema/spec ^1.1.0`、**`@tanstack/ai` 是 peerDependency，pin 精确版本 `0.53.0`**（2026-09-10 审查改：宿主自装、与库共用同一份实例——R7 的登记检查与引擎的中间件判断都靠引用同一性，装两份会把审批全判成没登记；非 `^`，不随小版本漂移；除主入口外还用了 `@tanstack/ai/adapter-internals` 的中断登记表 Capability，R7）；`@reins/brain` 只在 devDependencies（测试用脑子模块，运行时不依赖）。本文以代码为准。

## 1 架构概览

这个包把 reins 的脑子（Socket）装进 TanStack AI 的 `chat()` 里，形态是一个 chat middleware：

```
reinsMiddleware(options: ReinsMiddlewareOptions): ReinsChatMiddleware
  // = ChatMiddleware<unknown, ReinsApprovalInterrupt>
options: { sessionId, log, blobs?, memory?, sockets?, principal?,
           capabilities: Partial<LoweringCapabilities> & { contextWindow: number },
           registry?, projection?{strategies,estimate,reserveTokens},
           onLandings?, onEvent?, onHandoff?, emitCustomEvents?, warn?, announceToolChanges?, now?, newId? }
```

**循环归 TanStack，日志仍是唯一真源。** 轮次推进、工具执行、中断暂停全由 TanStack 引擎做；reins 不复制一份循环，只在钩子上"读日志 → 投影 → 覆盖模型入参"和"把模型输出写回日志"。TanStack 自己的 `messages` 数组只服务客户端 UI 与它的内部对账（pending 调用、审批状态），模型真正看到的是 `onConfig` 返回的 `providerMessages`。

```
客户端 ──messages──▶ chat({ adapter, messages, tools, systemPrompts,
                            middleware:[reinsMiddleware(...)],
                            interrupts:[reinsApprovalInterrupt] })
                                      │  TanStack 的循环
                                      ▼
        ┌──────────────────── middleware 钩子 ────────────────────┐
        │ onConfig(init) │ onConfig(beforeModel) │ onChunk        │
        │ onUsage │ onInterruptBoundary(afterModel / beforeTools) │
        │ onBeforeToolCall │ onAfterToolCall │ onToolPhaseComplete│
        │ onShouldContinue │ onInterruptResolution │ onAbort/Error│
        └───┬───────────────────────────────────────────┬─────────┘
     读方向 │                                            │ 写方向
            ▼                                            ▼
    readTimeline ─▶ project()（裁剪/折叠）        草稿 EventDraft
            │              │                            │
            │              ▼                            ▼
            │         Socket[].beforeModel      append() / settle()
            │         （补丁 events/tools/       （分配 seq、createEvent、
            │           systemPrompt、emit）      log.append、onEvent、
            │              │                      CUSTOM chunk 外推）
            │              ▼                            │
            │      toModelMessages() ──▶ providerMessages│
            │      （角色只在这里出现，落点记 landings）  │
            ▼                                            ▼
        ┌──────────────────── EventLog（唯一真源，只 append）────────────────────┐
        └───────────────────────────────────────────────────────────────────────┘
                                      ▲
    BlockAssembler ◀── onChunk（AG-UI 流）│ Socket[].afterModel / beforeTool /
    （拼成完整块）───── EventDraft ───────┘ afterTool / onTurnEnd（emit 草稿同路入日志）
```

一次 `chat()` 调用 = 一次 run，run 状态放在 `WeakMap<ChatMiddlewareContext, RunState>`（不用 TanStack 的 `MetadataStore`）。

## 2 文件清单

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 唯一导出口；把 middleware / messages / assembler / tools / interrupt / schema / loss-matrix 的公开面拢在一处，并声明"`@tanstack/ai` 的类型只在本包出现"。 |
| `src/middleware.ts` | 主体（约 930 行）：`reinsMiddleware()`，十一个 TanStack 钩子 → 五个 Socket 方法的翻译，run 状态、事件 append、审批中断、交接、用量记账都在这里。 |
| `src/messages.ts` | 事件 ⇄ TanStack `ModelMessage` 的纯函数翻译：出口 `toModelMessages`（含 trust 标注：untrusted 内容调 core `markUntrusted` 包 `<untrusted>`，`trustMarkers` 可关）、入口 `importModelMessages`（每条草稿的 `provenance.ref` 是幂等键 `importRef`：消息 id 或客户端数组位置）与 `dedupeImportedUserMessages`（R5 去重），外加 `trailingUserMessages`、`framedSystemNote`、`parseArgs`。 |
| `src/assembler.ts` | `BlockAssembler`：把流式 AG-UI chunk（TEXT_* / REASONING_* / TOOL_CALL_*）拼成完整内容块的 `EventDraft`，`finish()` 收尾未闭合的块。 |
| `src/content.ts` | 内容片段互译：`toTanstackParts` / `toTanstackContent` / `fromTanstackContent` / `fromTanstackToolResult`，翻不动的片段留占位文本并报 `dropped`。 |
| `src/tools.ts` | 工具桥接：`viewOfTanstackTool`（宿主工具 → reins 只读视图，打 `NATIVE_TOOL` 标记）、`toTanstackTool`（reins 工具 → TanStack 工具，包 `ToolContext` 并把归一结果存进 `ToolBridge.outputs`；工具返回 core 的 `subagentPause` 时降级为 isError——TanStack 边界不能只暂停一个工具，子会话保留可续跑）。`toolContextBase.spend` 由 middleware 提供，子代理用量计入 `s.tokensSpent`。 |
| `src/interrupt.ts` | `reinsApprovalInterrupt`（`defineInterrupt`）：动态审批在 TanStack 里的落点，含 payload / response 两个 schema 与 `REINS_APPROVAL_INTERRUPT_ID = "reins.approval"`；头注释写明类型层 + 运行时两道漏登记保护（R7）。 |
| `src/schema.ts` | `reinsSchema()`：手写的 Standard Schema（同时满足 `StandardSchemaV1` 与 `StandardJSONSchemaV1`），只为 `defineInterrupt` 服务，不引 zod；附 `isRecord`。 |
| `src/loss-matrix.ts` | `TANSTACK_LOSS_MATRIX`：本路径每种事件类型的可能落点（exact / lossy / dropped），与 lowering-pi 的矩阵同形。 |
| `src/testing.ts` | `scriptedAdapter(script)`：脚本化 TanStack 文本适配器，按剧本吐 AG-UI chunk 并把每次 `chatStream` 收到的 `TextOptions` 记进 `calls`（断言"模型看到了什么"就看它）；配套 `say` / `think` / `callTool` 与 `SCRIPTED_MODEL` / `SCRIPTED_PROVIDER`。文本拆两段 delta、thinking 签名故意排在 END 之后，专门压拼块器。 |
| `src/messages.test.ts`、`src/middleware.test.ts` | 单测与端到端。前者：`toModelMessages`、`importModelMessages / trailingUserMessages`（含幂等键与去重）、`BlockAssembler`、`toModelMessages：用户消息后移`；后者跑真实 `chat()` 引擎 + `scriptedAdapter`：`reinsMiddleware：基本流程`、`：脑子模块`、`：审批`（含漏登记中断的 fail-closed 用例，`withoutInterrupts`）。 |

## 3 核心流程

1. **init**（`onConfig(ctx.phase === "init")` → `initRun`）：`readTimeline(log, sessionId, { registry })` 先把整条日志过一遍注册表——读不出来的事件在写任何东西之前就拒绝（fail-closed）。
2. 宿主工具 `config.tools` 逐个 `viewOfTanstackTool` 成只读视图，连同 `sockets` 交给 `await resolveSocketContributions`（P1 起 async），拿回"视图 + 脑子工具"的 `baseTools` 与脑子的规则提示片段；`systemPrompts = [...config.systemPrompts, brainPrompt?]`——宿主原有条目（可能带 `cache_control`）一个字不动，脑子片段追加成最后一条，整个 run 逐字不变。 随后 append 一条 `core.tools_bound`（P1，与 runLoop 共用 `toolsBoundDrafts`；configHash 只按脑子片段算，与 runLoop 的不可比、只在本适配器内前后自比），工具表与上一条相比有增删且 `announceToolChanges !== false` 则再 append 模型可见说明。
3. **导入客户端新输入**：日志为空则 `config.messages` 整段接管，否则只取 `trailingUserMessages(config.messages)`（末尾连续的 user），经 `importModelMessages`（传 `startIndex` = 这一截在客户端数组里的起始下标）变成草稿，再经 `dedupeImportedUserMessages` 对照日志去掉重发的用户消息（R5，跳过时 `warn` 一句）后 `append` 入日志；片段翻不动时 `warn`。init 返回 `{ tools: tanstackToolsOf(...), systemPrompts }`。
4. **每轮 beforeModel**（`onConfig(phase = "beforeModel" | "structuredOutput")` → `beforeModel`）：重读日志 → `buildTurn` 里 `project()` 按 `capabilities.contextWindow` 投影（策略新造的事件先 `log.append`，保证"模型可见 ⟺ 已记录"）→ 造 `TurnContext`（含 budget：`targetTokens` / `used` / `tokensSpent` / `turns` / `toolCalls` / `wallMs` / `lastUsage`）。
5. 依次 `sock.beforeModel(tctx)`，补丁可换 `events` / `tools` / `systemPrompt`；随后 `flush` 把钩子 `emit` 的草稿落日志，并把其中非 `DEFAULT_MODEL_INVISIBLE_TYPES` 的事件追加进本轮可见集——**emit 的说明当轮就能被模型看见**。
6. `s.assembler.reset()`，`toModelMessages(visible, { model })` 译出 `providerMessages`，非 exact 的落点交 `onLandings`；返回 `{ providerMessages, tools: tanstackToolsOf(s, tools), systemPrompts }`。
7. **模型输出回流**（`onChunk`，phase 为 `modelStream` / `structuredOutput`）：每个 chunk 喂 `BlockAssembler.push`，拼完整的块（`core.model_text` / `core.model_thinking` / `core.tool_call`）逐块 `append` 入日志，并计进 `turn.modelEvents` / `turn.toolCalls`。
8. **`onUsage`**：`toReinsUsage` 把 TanStack 口径（`promptTokens` 含缓存）换成 reins 口径（input 不含 cacheRead/cacheWrite），累加 `tokensSpent`、回写 budget，并 append 一条 `core.budget_usage`（带 `contextEstimate` = 本轮投影估算，供感知校准）。
9. **`onInterruptBoundary(afterModel)`**：`assembler.finish()` 收尾未闭合的块 → `sock.afterModel(tctx, turn.modelEvents)` → `flush`。
10. **`onInterruptBoundary(beforeTools)`** → `beforeTools`：`pendingToolCalls(timeline)` 取本批待执行调用；已有拒绝决定的直接记 `block`；否则按 **runLoop 同一顺序**跑管线——逐个 `sock.beforeTool(tctx, seen, tool)`，`rewrite` 替换入参后继续问后续 Socket，任一 `block` / `defer` 即定，已批准的调用遇到 `defer` 略过。
11. 工具自带 `needsApproval` 的兜底（仅 reins 工具，宿主工具交 TanStack 原生审批）：**先 `tool.validate(args)` 再判 `needsApproval` 与写摘要**（R1，与 runLoop / approval 模块同序）；校验不过就不问人，留给执行时 `toTanstackTool` 报"入参不合法"。
12. 需要审批的：`emit` 一条 `core.approval_request`（同 id 已请求过则不重复）；**宿主没把 `reinsApprovalInterrupt` 登记到 `chat({ interrupts })`（init 时经 `GenericInterruptDefinitionRegistryCapability` 查过、已 `warn` 一次）则问不了人，再 `emit` 一条 `approval_decision(approved: false, by: "reins")` 并记 `block`（R7，fail-closed）**；登记了才发 `reinsApprovalInterrupt.interrupt({ key: toolCallId, ... })`，结论缓存成 `{ kind: "await" }`；有中断则 append `core.run_paused(reason: "approval")` 并把 `{ interrupts }` 返回给 TanStack，run 就此暂停。
13. **`onBeforeToolCall`** 只读缓存结论：`block → { type: "skip", result: { error } }`，`rewrite → { type: "transformArgs", args }`，其余放行——判定与执行分离，同一批调用的判定顺序不受 TanStack 并发执行影响。
14. **`onAfterToolCall`** → `afterTool`：日志里已有结果就跳过（幂等）；`block` 的写成拦截错误结果；否则优先取 `bridge.outputs` 里 reins 归一后的 `ToolResult`（比 TanStack JSON 化后的形态精确），再逐个 `sock.afterTool(tctx, call, draft)` 允许整条替换（外溢等），最后 `settle`——**先 flush 留痕（`memory_op` / `approval_decision`），再落结果**。
15. **`onToolPhaseComplete`** 补漏：TanStack 自己处理掉、没走 `onAfterToolCall` 的调用（原生审批拒绝、未知工具、入参解析失败、客户端回填、取消）补记 `core.tool_result`；原生审批的请求与结论镜像进日志（`policyId = "tanstack.needsApproval"`，`by = "tanstack"`）；有待审批 → `run_paused(approval)`，有待客户端执行 → `run_paused(host)`。
16. **`onInterruptResolution`**：把每条答复记成 `core.approval_decision`（取消记 `approved: false, reason: "审批被取消"`），有事件则补一条 `core.run_resumed`，返回 `{ toolResume: "continue" }`。
17. **`onShouldContinue`**：缺省沿用 TanStack 的判断（本轮有工具调用则继续），任一 `sock.onTurnEnd` 给出决定即采纳并跳出；`continue → true`，`stop → false`，`pause → append run_paused + false`，`handoff → doHandoff（旧会话记 core.handoff，新 sessionId 下写"摘要 system_note + opening + triggerMessage"）+ false`。
18. **`onAbort` / `onError`**：都先 `assembler.finish()` 保住半截输出，再分别落 `core.run_paused(host)` / `core.error(category: "tanstack-ai")`。
19. 贯穿全程的 `append()`：唯一分配 `seq` 的地方（与 runLoop 同约定），`createEvent` 过注册表 → `log.append` → 回调 `onEvent` → 非正文类事件（不在 `CONTENT_TYPES` 里的）以 AG-UI `CUSTOM` chunk 推给前端（`emitCustomEvents` 缺省开）。

## 4 核心设计决策

- **日志是唯一真源，TanStack 的 messages 只给 UI** — 每轮 `onConfig` 用日志投影产出 `providerMessages` 覆盖掉 TanStack 手上的历史。理由（DECISIONS 2026-09-08 B10）：两份历史并存时必须有且只有一个真源，否则 compact / spill / pin 的效果会被客户端重发的全文覆盖。边界：宿主若想让客户端历史为真源，就不该用本适配器。
- **客户端历史只导入"新的那一截"** — 日志为空整段接管，否则只取末尾连续的 user 消息（`trailingUserMessages`）。理由：TanStack 客户端每次把整段历史连同新输入一起发来，历史部分日志里已经有了。边界（R5，2026-09-10）：**幂等键 = 客户端消息自带的 `id`，没有就用它在客户端完整数组里的位置，且内容逐字相同才算重发**——同一请求被网络重试时末尾用户消息只入日志一次，模型接着日志里已有的历史走（已有完整回答时会再答一次，不会把用户消息记两遍）；用户真的连说两遍同样的话位置不同、照常导入；客户端自行裁剪历史会让位置漂移，退化成不去重而绝不误删。宿主自己 `append` 的用户消息（来源不是 `tanstack-ai`）不参与去重。
- **动态审批落成通用中断** — TanStack 自带审批只认工具上静态的 `needsApproval: true`，reins 的审批按入参动态判定（Socket 返回 `defer`），只能在 `beforeTools` 边界以 `reinsApprovalInterrupt` 表达，答复在 `onInterruptResolution` 记成 `approval_decision`。理由（DECISIONS B10 第二条）：两套审批并存但日志形状同一，前端与回放不分路径。边界：宿主必须把它登记到 `chat({ interrupts })`，否则 TanStack 在边界抛 "not registered on this chat"，run 会死在一条等不到答复的 `run_paused` 上；`ReinsChatMiddleware` 的第二个类型参数让漏登记在类型层就报出来，**运行时再兜一道（R7，2026-09-10）**：init 用引擎同一判据（`ctx.getOptional(GenericInterruptDefinitionRegistryCapability)` 里按引用查 `reins.approval`，这是 `@tanstack/ai/adapter-internals` 的导出、随主包 pin 0.53.0）判定登记情况，没登记 `warn` 一次、需审批的调用降级为拒绝并留 `approval_request` + `approval_decision(false, by: "reins")`，工具绝不会在没人批的情况下执行。
- **原生 needsApproval 只镜像不接管** — 宿主工具的静态审批仍走 TanStack 自己的流，适配器只在 `onToolPhaseComplete` 把请求与结论抄进日志（`policyId = "tanstack.needsApproval"`）。边界：TanStack 不告诉我们是谁拒的，`by` 只能记成 `"tanstack"`。
- **`validate` 前移到审批判定之前（R1）** — `beforeTools` 里先校验入参再问 `needsApproval` 与生成摘要，与 runLoop、approval 模块三处同序（DECISIONS 2026-09-09 R1）。理由：审批人批的必须是将要执行的那份入参。边界：`rewrite` 仍在 `validate` 之前（钩子改的是模型给的原始入参）；校验不过不问人，直接由执行期报错拒掉。
- **判定与执行分离** — 整批调用的 `beforeTool` 结论在边界一次算完存进 `verdicts`，`onBeforeToolCall` 只查表。理由：钩子形状要求同步给出 skip / transformArgs，且 TanStack 可能并发执行。边界：`defer` 会让**整轮**工具都等审批（TanStack 在边界暂停不执行任何调用），默认循环则会先执行不需审批的——已声明的差异（DECISIONS B10 第三条 ③）。
- **有损必须声明：`TANSTACK_LOSS_MATRIX`** — `ModelMessage` 只有 user / assistant / tool 三角色，于是 `system_note` 以 `<system_note kind=…>` 标签走 user、`compaction` 走 user 文本、同一响应多段正文合成一个字符串（`merged-text`）、`isError` 只落 `ModelMessage.error` 字段、运维事件不下发。每条事件都记一条 `LandingRecord`，测试断言实际落点必在矩阵中且矩阵无死条目。
- **trust 标注与 lowering-pi 同一份函数（R9）** — `toModelMessages` 对 `trust === "untrusted"` 的事件调 `@reins/core` 的 `markUntrusted` / `markUntrustedText`，`tool` 消息的 `content` 与 `error` 字段都是包裹后的文本；`ReinsMiddlewareOptions.trustMarkers: false` 关掉。理由：两条降级路线的标记必须逐字一致，共用纯函数是唯一不会漂移的办法。边界：TanStack 的 `content` 全文本时是单个字符串，包裹后仍是单个字符串；含图片时是片段数组，标记落在首尾文本片段上。
- **thinking 无同源签名不下发** — 只有 `replay.thinkingSignature` 存在且 `provider`/`model` 与本次请求一致才回放，否则记 `dropped`。理由（`messages.ts` 注释）：多数厂商拒收无签名的 thinking 块，让适配器崩掉比丢一段思考更糟。
- **`lossy(user)`：用户消息与说明后移** — 落在 `tool_call` 与 `tool_result` 之间的 user 角色内容（`system_note`、`compaction` 留痕，以及用户在结果回来前插的话）在翻译时后移到同批工具结果之后，落点备注注明。理由（DECISIONS 2026-09-09 上线前审查）：日志顺序不动（宪法二：插话就是再追加一个事件），"tool_result 必须紧跟 tool_use"是厂商线协议约束，属降级层职责。边界：只后移，不合并、不丢弃。
- **宿主 systemPrompts 原样保留** — 不把宿主提示交给 `resolveSocketContributions`，只取它算出的工具表与脑子片段，脑子片段追加成最后一条且整个 run 逐字不变。理由（`initRun` 注释）：宿主条目可能带 `cache_control` 之类元数据，改动前缀会打掉缓存。边界：Socket 在 `beforeModel` 返回 `systemPrompt` 时本轮改为只发这一条。
- **思考块延后产出** — `BlockAssembler` 遇到 `REASONING_MESSAGE_END` 不结块，要等下一个非思考 chunk 或 `finish()`。理由（`assembler.ts` 注释）：签名可能在 `REASONING_ENCRYPTED_VALUE` 或 `STEP_FINISHED.signature` 里，且真实适配器（Anthropic）会把它排在 END 之后。
- **reins 工具的结果走 `bridge.outputs`** — 包装层执行完先把归一后的 `ToolResult` 按 `toolCallId` 存进桥，`afterTool` 从那里取精确的 content / isError，而不是 TanStack JSON 化之后的形态。边界：`isError` 在 TanStack 里只能以"执行抛错"表达，抛出的文本只给客户端看，日志里落的是桥里那份。
- **手写 Standard Schema，不引校验库** — `defineInterrupt` 只接受 Standard Schema，为两个小形状引 zod 不划算，于是按规范自己写 `~standard` 三件套（`reinsSchema`）。边界：`check()` 只做形状校验，够 TanStack 算定义哈希与校验客户端回填即可。
- **`@tanstack/ai` 类型只在本包出现，且 pin 精确版本 `0.53.0`** — 上游钩子契约（`onConfig` 可同时改 `providerMessages`/`systemPrompts`/`tools`）是读 dist 类型与 compose.js 源码核实的（DECISIONS 2026-09-08 S2），不随小版本漂移。
- **run 状态不进 `MetadataStore`** — 放 `WeakMap<ChatMiddlewareContext, RunState>`，持久的东西一律进 EventLog。理由（DECISIONS S2）：`MetadataStore` 是需中间件在 `setup` 里 `provide` 的命名空间 KV，无默认实现。

> 未在本包核实（TASKS 待办）：真适配器 `@tanstack/ai-anthropic` + 真模型下 `providerMessages` 的角色序列、`thinking` 签名回放、`error` 字段是否传给模型，以及 TanStack 原生审批的客户端续跑，均待 B11 dogfood。
