# @reins/lowering-pi 模块盘点

> 以 `packages/lowering-pi/src/` 代码为准；术语对照 `docs/技术方案.md` §11、决策出处标 `docs/DECISIONS.md`。

## 1 架构概览

本包是 `@reins/core` 的 `Lowering` 接口在 **pi-ai** 上的第一个实现，只做两件事：把投影后的事件翻成某家 API 的请求（`toRequest`），把流式响应翻回事件草稿（`stream`）。它是整个仓库里唯一允许出现"角色"概念的地方（宪法二）。

依赖只有两个：`@earendil-works/pi-ai` **pin 精确版本 `0.85.1`**（package.json 里没有 `^`，S4 决策）与 `@reins/core`（workspace）。第一版只认两条线协议：`anthropic-messages` 与 `openai-responses`（`SUPPORTED_APIS`），其余在 `resolveModel` 里就抛 `LoweringError("unsupported_api")`。

翻译分两跳，这是理解本包的关键：

- 第一跳（本包 `to-request.ts`）：事件 → pi-ai `Context`，也就是 **三角色** `Message[]`（`user` / `assistant` / `toolResult`）。pi-ai 的 Message **没有 system 角色**。
- 第二跳（pi-ai 内部）：`Context` → 线协议 JSON。本包不碰这一步，只在 pi-ai 公开的 `onPayload` 钩子上改写产物（`system-note.ts`），把带内部标记的 user 消息还原成真正的 `system` / `developer` 消息并按厂商规则归位。

```
   投影后的 events[]                        ┌──────── @reins/lowering-pi ────────┐
   tools / systemPrompt / ModelRef  ───────►│ toRequest()                        │
                                            │  resolveModel ─► capabilitiesOf    │
                                            │        └─► eventsToContext         │
                                            │              ├─ Message[]（三角色）│
                                            │              └─ LandingRecord[]    │
                                            │                     ▲              │
                LoweredRequest{ capabilities, landings, payload } ─┘              │
                                │                                                │
                                ▼                                                │
                              stream(req)                                        │
                                │  apiKey(provider) → 缺则 LoweringError          │
                                ▼                                                │
                        pi-ai api/<api>.stream(model, context, options)           │
                                │                                                │
                                │  onPayload(payload, model)  ◄── 线协议请求体草案 │
                                │      └─ rewritePayload：标记消息 → system/dev， │
                                │         Anthropic 还要归位 + 处置缓存断点        │
                                ▼                                                │
                        HTTP（Anthropic Messages / OpenAI Responses）             │
                                │                                                │
                        AssistantMessageEvent 流                                  │
                                ▼                                                │
                        consumeStream ──┬─► ctx.onDelta(增量，只给 UI，不进日志)   │
                                        └─► CoreEventDraft[] + LoweringOutcome    │
                                            └──────────────────────────────────────┘
```

**"pi-ai 类型不出本包"在代码里的三处落地**：① 对外的 `PiLoweredPayload` 用我们自己的结构描述请求体（`{ api, context: { systemPrompt?, messages: readonly unknown[], tools? } }`），不引用 pi-ai 的 `Context`；② 宿主要用内置表以外的模型，用我们自己的 `ModelDefinition` 描述，`definitionToModel` 再补齐 pi-ai `Model` 需要的字段；③ `index.ts` 导出的类型里没有任何 pi-ai 类型，`ModelOrigin` / `ThinkingReplay` / `TextReplay` / `ToolCallReplay` 都是本包自定义。代价是 `stream()` 里有一次 `req.payload.context as Context` 的回收式断言 —— 放进 payload 的对象**就是** pi-ai 的 Context 本体，只是类型上被描述成了 `unknown[]`。

## 2 文件清单

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 公共出口：工厂、`PiAiLowering`、矩阵、模型解析、system_note 工具函数与 replay 类型 |
| `src/pi-lowering.ts` | `PiAiLowering` 类本体：实现 `capabilities` / `toRequest` / `stream`，装配 apiKey、fetch、headers、requestOptions 与 `onPayload` 钩子；导出 `rewritePayload` 按 api 分派 |
| `src/models.ts` | `ModelRef` → pi-ai `Model`：内置只挂 `anthropic.models` / `openai.models` 两张静态表，宿主模型经 `ModelDefinition` → `definitionToModel` 补齐；不支持的 provider / api 在这里抛 `LoweringError` |
| `src/capabilities.ts` | 按模型 id 正则与 requestOptions 推断 `LoweringCapabilities`（`midConversationSystem` / `taskBudget` / `thinkingReplay` …），宿主声明的 `CapabilityOverrides` 覆盖推断结果 |
| `src/factories.ts` | 一行拿到"模型 + 降级层"的 `anthropic(id, opts)` / `openai(id, opts)`，返回 core 的 `BoundModel`；带 `baseUrl` 即按 `ModelDefinition` 登记走代理/网关 |
| `src/to-request.ts` | 核心翻译：`eventsToContext` 把事件流分组成三角色消息，同时逐条记 `LandingRecord`；后移队列（`deferred` / `awaiting`）在这里 |
| `src/system-note.ts` | system_note 的第二跳：内部标记常量与包裹函数、Anthropic 请求体改写与归位算法（含缓存断点三种处置）、OpenAI Responses 改写 |
| `src/from-stream.ts` | 回程：`draftsOf` 把 pi-ai `AssistantMessage` 的内容块变成事件草稿，`consumeStream` 消费事件流、分发增量、收尾产出 `LoweringOutcome` |
| `src/loss-matrix.ts` | `LOSS_MATRIX`（api → 事件 type → 可能落点）与 `declaredLandings` 查询；这是"禁止静默丢弃"的合同文本 |
| 测试（4 个 `*.test.ts`） | `loss-matrix.test.ts` 逐变体断言实际落点必在矩阵内且矩阵无死条目；`pi-lowering.test.ts` 用假 fetch 走两条协议全链、单测归位规则；`to-request.test.ts` 专测说明后移与用户消息后移；`factories.test.ts` 测两个工厂的缺省与透传 |

## 3 核心流程

### 3.1 `toRequest`：事件 → 三角色消息 + 落点

1. `PiAiLowering.toRequest` 先 `resolveModel(input.model, extraModels)`（宿主模型优先于内置表），再 `capabilitiesFor` 取能力（`capabilitiesOf` + 宿主 `overrides`），最后把两者交给 `eventsToContext`。
2. `eventsToContext` 顺序遍历事件。连续的 model 事件（`model_thinking` / `model_text` / `tool_call`）由 `assistant()` 攒进同一个 group；遇到任何非 model 事件、或 group 的来源（`replay` 里的 provider/api/model）变了，就 `flush()` 收口成一条 `AssistantMessage`（`stopReason` 按是否含 toolCall 取 `toolUse` / `stop`，usage 填 `ZERO_USAGE` 占位）。
3. `flush()` 时把这条 assistant 里所有 toolCall 的 id 记进 `awaiting`。**只要 `awaiting` 非空，就意味着"这批工具结果还没到齐"**。
4. 期间每条事件都调 `land()` 记一条 `LandingRecord`。`landings.length` 恒等于输入事件数（矩阵测试断言了这一点）。
5. 收尾：`flush()` + `settleAwaiting()`，把 tools（`ToolSpec.inputSchema` 直接透传为 pi-ai 的 `parameters`）与 `systemPrompt` 装进 `Context`。

### 3.2 后移：`awaiting` 与 `deferred`

线协议硬规则是"同一批 `tool_result` 必须紧跟 `tool_use` 所在的 assistant，中间不能插别的消息"，否则 Anthropic（含 DeepSeek 兼容端口）直接 400。而时间线里两类东西会插进来：

1. **并行工具之间的说明**：`pin` / `memory` 留痕的 `system_note`、`compaction` 摘要。它们走 `note()`；`awaiting.size > 0` 时不进 `messages`，压进 `deferred`。
2. **用户插话**：续跑带新 input、进程死亡后用户再发消息，`core.user_message` 分支里同样判 `awaiting.size > 0`，压进 `deferred` 并**显式记 `lossy` / `landing: "user"`**（矩阵里的 `USER_DEFERRED` 条目），因为顺序真的变了。
3. 每收到一条 `tool_result` 就 `awaiting.delete(toolCallId)`；`awaiting` 清空时 `releaseDeferred()` 把攒下的消息按原顺序放出，落点备注追加 `DEFERRED_NOTE`（"已后移到同批工具结果之后…"）。
4. 兜底：新的模型输出到来时 `assistant()` 会调 `settleAwaiting()`（清 `awaiting` + 放出 `deferred`），因为视图被切在结果之前、这批结果不会再来了。函数末尾也再调一次。
5. **日志本身不动**（宪法二）：用户插话就记在它发生的位置，后移只发生在翻译产物里。

### 3.3 system_note 的两跳与 Anthropic 归位

1. 第一跳在 `eventsToContext` 的 `core.system_note` 分支：`capabilities.midConversationSystem` 为真 → `markSystemNote(text)` 前缀上 `[[reins:system_note]]` 标记、以 **user** 消息进 Context，落点记 `exact`（Anthropic 记 `system`，OpenAI 按 `model.reasoning` 记 `developer` / `system`）；为假 → `framedSystemNote(kind, text)` 用 `<system_note kind="…">` 标签包住、仍走 user，记 `lossy` / `user-role`。
2. 第二跳在 `PiAiLowering.stream` 装的 `onPayload` 钩子 → `rewritePayload(api, …)` 分派。
3. `rewriteOpenAIResponsesPayload`：Responses 的 `input` 项允许任意位置的 developer / system 消息，所以只做**原地替换**，无归位；角色按 `model.reasoning` 选 `developer` / `system`。没有标记消息时返回 `undefined`（= 请求体不变）。
4. `rewriteAnthropicPayload` 要满足官方摆放规则（不能是首条、必须紧跟 user 轮、后接 assistant 或收尾、连续 system 视为一组），算法是：先把标记消息全部摘出成 `pending`、其余成 `body`；`placeOf()` 为每条算出它在 **原始 body** 里的落点（"它之后的第一条 assistant"之前；没有 assistant 就落到末尾，并跳过 pi-ai 追加的 content 为空的 effort 专用 system；落点为 0 时挪到第一条 user 之后）；同落点的按原顺序装进 `groups`；最后一次性拼出 `messages`。**先算完再拼、不边算边 splice**，否则同一落点的多条说明会前后颠倒。
5. 缓存断点：pi-ai 把 `cache_control` 打在"最后一条 user 消息"上，而感知说明殿后时那条最后的 user 正是我们的标记消息，改写成 system 后断点会消失 → 整段历史按原价计费。`markedNote` 把断点一起摘出来，按 `midSystemCacheBreakpoint` 处置：`automatic`（缺省，丢块级断点、请求顶层补 `cache_control`，且先用 `countBlockBreakpoints` 数够 4 个就放弃以免 400）、`previous-user`（`withCacheControl` 搬到紧邻的前一条 user 消息末块）、`drop`。

### 3.4 `stream`：请求 → 事件草稿

1. `resolveModel` 拿回模型，`opts.apiKey(model.provider)` 取 key，**缺 key 直接抛 `LoweringError("missing_api_key")`**（不是返回 error 态）。
2. 组装 `StreamOptions`：`requestOptionsFor(ref)` 展开在最前（宿主可覆盖大部分），随后 apiKey、可选 fetch / headers / signal，以及 `onPayload` 钩子。
3. `streamFunctionFor(api)` 在两条 `api/<api>` 子路径导入的 `stream` 之间二选一，调用它拿到 `AsyncIterable<AssistantMessageEvent>`，`yield* consumeStream(...)`。
4. `consumeStream` 只把 `text_delta` / `thinking_delta` / `toolcall_delta` 转给 `ctx.onDelta`（给 UI，不落日志）；`done` / `error` 时才 `yield* draftsOf(msg)` 产出草稿并 `return outcomeOf(...)`。流在 done / error 之前就结束时返回一条 `stopReason: "error"` 的兜底 outcome。
5. `draftsOf` 逐内容块产草稿：`thinking` → `core.model_thinking`（replay 带 `thinkingSignature` / `redacted`）、`text` → `core.model_text`（replay 带 `textSignature`，**空文本块跳过**）、`toolCall` → `core.tool_call`（replay 带 `thoughtSignature` / `namespace`）。每条 replay 都带 `{ provider, api, model }`，这是回放时判"是不是自己产的"的依据。
6. 回程的 `thinking` 回放在去程 `to-request.ts` 的 `core.model_thinking` 分支消费：有签名且同源 → `exact`（`thinking-block` / `reasoning-item`）；无签名 → `lossy` / `text-or-drop`；`foreignOrigin`（provider 或 api 不同）→ `lossy` / `provider-dependent`；只是 model id 不同 → 仍 `exact`，只在备注里留痕。

## 4 核心设计决策

**pi-ai 类型不出本包** — 对外用 `PiLoweredPayload` / `ModelDefinition` / 自定义 replay 类型描述一切，pi-ai 的 `Message` / `Context` / `Model` / `AssistantMessageEvent` 只在包内出现（S4，DECISIONS 2026-09-08）。为的是"降级层可换"这个卖点为真 —— 换实现只要满足 core 的 `Lowering` 接口。边界：`stream()` 内部仍要把 payload 断言回 `Context`，因为放进去的就是同一个对象；这个断言是本约束的唯一裂缝。

**只从子路径深导入** — 只用 `api/<api>`（流函数）与 `providers/<name>.models`（静态模型表），不用 `compat` 入口（上游注明将删）、不用 `providers/all`（会拉进 Bedrock 与 AWS SDK）（S4）。边界：内置模型表因此只有 anthropic 与 openai 两家，别的一律走 `ModelDefinition` 声明。

**system_note 走"标记 + onPayload 改写"两跳** — pi-ai 的 Message 没有 system 角色，又不想 fork pi-ai，所以先当 user 消息带标记进 Context，在 pi-ai 公开的钩子上改写成线协议的 system 消息（S1，DECISIONS 2026-09-08）。标记只在 `system-note.ts` 生产与消费，不会送到线上。边界：`LoweredRequest.payload` 里看到的仍是 user 角色，只有真发出去的请求体才是 system —— 调试时别拿 payload 当最终请求；上游若加入 system 角色，这套改写逻辑整段删掉即可。

**归位先算后拼** — `placeOf` 对**原始 body** 算完所有落点、分组，再一次性拼出 `messages`（`system-note.ts` 注释）。因为边算边 splice 会让同一落点的多条说明前后颠倒，而同轮多条 system_note 的顺序是有意义的。边界：算法只保证 Anthropic 那四条摆放规则，不保证"说明紧挨着它描述的那条事件"。

**缓存断点缺省 automatic** — 说明殿后时去掉 pi-ai 打在标记消息上的块级 `cache_control`、在请求顶层补一个（Anthropic 自动缓存）；块级断点已满 4 个则放弃补，不能让请求 400（B1，DECISIONS 2026-09-08）。理由是官方规则"最后一个断点之后的内容一律不缓存"，直接丢断点会让整段历史每轮重新计费；实测 `automatic` 与不注入持平，`previous-user` 低 3~6 个点，留在 system 消息上崩到 18.6%。边界：三种处置的实测是在网关与 DeepSeek 上做的，"直连官方 API 缺省是否仍最优"仍是未实测项。

**说明与用户消息一律后移** — 落在 `tool_call` 与 `tool_result` 之间的 system_note / compaction / user_message 后移到同批结果之后（DECISIONS 2026-09-09 两条：E3 附、上线前审查）。因为"同批 tool_result 紧跟 tool_use"是厂商硬规则，DeepSeek 直接 400；而宪法二要求日志顺序不动，所以这件事只能由降级层在翻译时做。边界：说明后移只记备注仍算 `exact`，用户消息后移记 `lossy(user)` —— 前者模型看到的内容没变、只是位置，后者对话顺序真的变了。

**有损矩阵是合同，测试守着** — `LOSS_MATRIX` 声明 api × 事件 type 的所有可能落点，`toRequest` 记录的每条实际落点必须命中其中一条，且矩阵里不能有从未被命中的死条目（`loss-matrix.test.ts`）。新增事件类型或新 API 不补表，测试就红。边界：矩阵只覆盖"落到哪"，不覆盖"落得对不对"，后者靠 `pi-lowering.test.ts` 的假 fetch 请求体断言。

**运维事件一律不下发** — `approval_request` / `approval_decision` / `run_paused` / `run_resumed` / `budget_usage` / `memory_op` / `handoff` / `core.error` 记 `dropped/none`，`ext.*` 同样（`NOT_SENT`）。这些信息由别的事件承载（审批结果在 `tool_result.isError`、交接由新会话首条 user 承载）。边界：投影层默认已经过滤掉它们，矩阵这一层是**第二道声明**而非唯一防线；宿主要让模型看见 `ext.*`，得在投影层翻成 core 事件。

**来源判定只比 provider + api** — `foreignOrigin` 不比模型 id，因为响应报告的 id 常与请求的不同（日期后缀、别名、网关改名），按 id 严格比会把自家签名误判成别家（DECISIONS 2026-09-08，网关探针）。边界：id 不同时仍记 `exact`，只在 note 里写明签名来自哪个 id。

**草稿只在内容块完整时产出** — 签名类回放数据（Anthropic signature、OpenAI reasoning item）在块结束时才齐，所以 `consumeStream` 到 `done` / `error` 才产草稿，增量只经 `onDelta` 给 UI（T7，`from-stream.ts` 注释）。边界：中断或出错时也把已产出的部分内容交出去 —— 日志要记录"发生过什么"，是否继续由循环决定；pi-ai 的 `deferred` 停止原因（异步批处理句柄）第一版不支持，按 `stop` 收尾。

**OpenAI 的 thinkingReplay 如实声明** — Responses 只在请求带 `reasoningEffort` / `reasoningSummary` 时才开 reasoning 并返回 `encrypted_content`，所以 `capabilitiesOf` 对这家把 `thinkingReplay` 算成 `model.reasoning && openaiReasoningRequested(requestOptions)`（T7）。静默替宿主开 reasoning 会改变成本，所以宁可报 false 让脑子模块自己选等价表达。边界：`openai()` 工厂缺省塞了 `reasoningEffort: "medium"` 来保证有东西可回放；自己 new `PiAiLowering` 而不给 requestOptions 时，这家的 thinkingReplay 就是 false。

**能力按 id 正则推断，宿主可覆盖** — `ANTHROPIC_MID_SYSTEM` / `ANTHROPIC_TASK_BUDGET` 两条前缀正则覆盖内置 Anthropic 模型；第三方 Anthropic 协议上游（如 DeepSeek 兼容端口，2026-09-08 实测接受中途 system）由宿主在 `ModelDefinition.midConversationSystem` 声明，缺省按不支持（B1 附、B11 附，DECISIONS）。发错了是 400，发保守只是有损，所以缺省取保守。边界：覆盖字段存在 `PiAiLowering.overrides` 这张 `provider/id` 表里，不在 pi-ai 的 `Model` 上 —— 因为那个类型放不下。

**不读环境变量** — `apiKey` 是必填的 `(provider) => string | undefined` 回调，工厂的 `apiKey` 也必填（T7 / T14，DECISIONS 2026-09-08）。这样同一份代码能跑在没有 `process.env` 的 Workers / Deno 上。边界：宿主自己决定 key 从哪来。

**trust 标注在翻译那一刻做，逻辑不在本包（R9）** — `eventsToContext` 对 `trust === "untrusted"` 的 user_message / tool_result 片段、system_note / compaction 文本调 core 的 `markUntrusted` / `markUntrustedText`，包成 `<untrusted source="tool:<name>">…</untrusted>`，事件本身不动；内容里的提前闭合被转义时落点记 lossy 并说明。为什么：两条降级路线要输出一模一样的标记，只能共用一份纯函数（T6 把它划给降级层，实现放 core）。边界：`trustMarkers: false`（`ToContextInput` / `PiAiLoweringOptions` / `BoundModelOptions` 三层透传）关掉；不加解释性文字，宿主要强调"数据不是指令"写进 systemPrompt。
