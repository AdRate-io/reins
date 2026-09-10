# 模块盘点：`@reins/core`

> 以 2026-09-10 的 `packages/core/src` 代码为准。技术方案 §4~§8、§13 用作术语核对；两处出入在文末"与技术方案的出入"里列出。

## 架构概览

`@reins/core` 是 reins 的底盘：把"事件时间线"这一唯一真源，变成一次可暂停、可续跑、可回放的模型循环。它自己不认识任何厂商协议，也不含任何"脑子"策略 —— 前者在 `@reins/lowering-pi`，后者在 `@reins/brain`，两边都只通过本包定义的接口接入。

包内共六组能力，`src/index.ts` 平铺导出前五组，第六组走独立入口 `@reins/core/testing`（`tsup` 两个 entry）：

| 导出组 | 内容 |
| --- | --- |
| `events/` | 事件壳 `EventBase` / `Event`、16 种 `core.*` 载荷、`uuidv7`、schema 注册表与 upcast |
| `store/` | `EventLog` / `BlobStore` / `MemoryStore` 三接口、内存实现、`readTimeline`（读时升级的唯一正确读法） |
| `projection/` | 投影策略链（过滤 / 折叠 / 钉住 / 裁剪）、token 粗估、被折叠工具结果清单 |
| `lowering/` | 降级层**接口与有损矩阵类型**，外加一份两条降级路线共用的 trust 标注纯函数（R9） |
| `loop/` | `runLoop` 与它的插座（`Socket`、`Tool`）、run 状态签名与恢复校验、静态贡献解析、瞬断重试、fork |
| `replay/` | 只凭日志重算每轮模型看到了什么 |
| `testing/`（独立入口） | 三份存储一致性套件 + `ScriptedLowering` 脚本化降级层 |

依赖方向：`package.json` 里**零 dependencies**、零 `node:*`（P5），只用 Web 标准 API（`crypto.getRandomValues`、`crypto.subtle`、`structuredClone`、`TextEncoder`）。被 9 个包依赖：`@reins/brain`、`@reins/lowering-pi`、`@reins/server`、`@reins/ui-agui`、`@reins/adapter-tanstack-ai`、`@reins/store-sqlite`、`@reins/store-pg`、`@reins/eval`、`@reins/reins`（聚合包）。core 不反向依赖其中任何一个。

```
  宿主 input（string / ContentPart[] / EventDraft）
        │
        ▼
   ┌──────────────────────── runLoop（loop/run-loop.ts）────────────────────────┐
   │                                                                            │
   │  readTimeline(log, registry) ── 读时 upcast，未登记 / 未来版本即拒          │
   │        │ 完整时间线（唯一真源）                                            │
   │        ├─► 补齐 pending tool_call ──► executeToolCalls ──┐                 │
   │        ▼                                                 │                 │
   │  project(timeline) 过滤 → 折叠 → pins → 预算裁剪          │                 │
   │        │ view                    └─ emitted(阈值 compaction) ─┐            │
   │        ▼                                                 │    │            │
   │  Socket.beforeModel（脑子 emit system_note / 改视图）─────┤    │            │
   │        ▼                                                 │    │            │
   │  lowering.toRequest(view, tools) ── landings 逐条声明有损  │    │            │
   │        ▼                                                 │    │            │
   │  lowering.stream ──► EventDraft 逐块 ─────────────────────┤    │            │
   │        ▼                                                 │    │            │
   │  afterModel → beforeTool → validate → 审批 → execute      │    │            │
   │             → afterTool ─────────────────────────────────┤    │            │
   │        ▼                                                 │    │            │
   │  budget_usage → onTurnEnd                                 │    │            │
   │        │                                                 ▼    ▼            │
   │        └─► done | paused(+SerializedRunState) | handoff | error            │
   └───────────────────────────────┬────────────────────────────────────────────┘
                                   │ 所有 ├─► 都汇到这里
                                   ▼
                        EventLog.append（seq 只在 runLoop 内分配）
                                   │
                                   └─► 生成器 yield 每一条刚落库的事件 → 宿主 / AG-UI
                                   └─► replayTurns(日志) → 每轮 visible / output / usage
```

## 文件清单

### 根

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 主入口：re-export 六个子模块（testing 除外）并导出 `REINS_VERSION` |

### `events/` — 事件模型（T3）

| 文件 | 职责 |
| --- | --- |
| `events/index.ts` | 汇总导出 base / core / create / id / registry |
| `events/base.ts` | 事件公共壳 `EventBase`、`Event<T,P>`、`Actor`、`Trust`、`Provenance`、`ContentPart`（text / image）、各 actor 的默认信任 `DEFAULT_TRUST` |
| `events/core.ts` | 16 种内置事件的载荷 interface（P1 加 `ToolsBoundPayload`）、`CoreEventPayloads` 映射表与可判别联合 `CoreEvent`、`ExtEvent`，以及 `contextTokensOf(usage)`（input + cacheRead + cacheWrite） |
| `events/create.ts` | `EventDraft`（无 id/seq/at/sessionId 的草稿）与 `createEvent` / `createCoreEvent` 工厂：补齐壳字段、从注册表取 schemaVersion |
| `events/id.ts` | 自实现 `uuidv7`（RFC 9562，只用 `crypto.getRandomValues`，不引依赖） |
| `events/registry.ts` | `EventSchemaRegistry`：登记 type → 当前版本 + 逐级 upcaster，`read()` fail-closed（6 种 `SchemaError` code）；`CORE_SCHEMAS`（全部 v1）与 `createCoreRegistry()` |
| 测试 | `id.test.ts` 覆盖 uuidv7 格式 / 时间序 / 不重复；`registry.test.ts` 覆盖读正常路径、四类拒绝、v1→v3 升级链、登记期校验、工厂补齐；`types.test-d.ts` 是类型层断言（无运行时用例） |

### `store/` — 存储接口与内存实现（T4）

| 文件 | 职责 |
| --- | --- |
| `store/index.ts` | 汇总导出 errors / in-memory / read-timeline / types |
| `store/types.ts` | `EventLog`（append / read / tail / fork）、`BlobStore`、`MemoryStore`、`Stores`（只有 log 必需）、`ReadOptions` 的接口与行为契约注释 |
| `store/errors.ts` | `StoreError` 与 7 种 code（seq_conflict / session_mismatch / empty_batch / not_found / target_not_empty / out_of_range / invalid_argument） |
| `store/in-memory.ts` | 三个接口的进程内实现 + `memoryStore()` 一次给齐；读写都 `structuredClone`，是一致性套件的参考实现 |
| `store/read-timeline.ts` | `readEvents`（流式）/ `readTimeline`（整段）：从日志读出的每一条都先过 `registry.read` 升级，是循环、server、回放读日志的唯一正确姿势 |
| 测试 | `in-memory.test.ts` 直接跑 `../testing` 的三份一致性套件并验 `memoryStore()` 每次新建；`read-timeline.test.ts` 覆盖读时升级、区间透传、未登记 ext.* 与未来版本拒绝 |

### `projection/` — 投影（T6，技术方案 §8）

| 文件 | 职责 |
| --- | --- |
| `projection/index.ts` | 汇总导出全部策略与执行器 |
| `projection/types.ts` | `ProjectionStrategy` / `ProjectionContext`（只读上下文 + `nextSeq()`）/ `ProjectionStep`（events + emitted）/ `ProjectionStats` / `ProjectionResult` |
| `projection/filter.ts` | 策略 1 可见性过滤：`DEFAULT_MODEL_INVISIBLE_TYPES`（9 种运维事件，含 P1 的 `tools_bound`）+ 宿主可覆盖的 `isVisible` |
| `projection/fold.ts` | 策略 2 折叠：`covers` / `keptBy` / `isPinNote` / `supersededIds` 幸存判定，`foldCompactions` 把摘要插到**被覆盖区间的位置** |
| `projection/pins.ts` | 策略 3 钉住重注入：把幸存的被覆盖事件挪到覆盖它的最新可见 compaction 之后（去掉本策略投影仍正确，只是顺序不好读） |
| `projection/truncate.ts` | 策略 5 预算裁剪兜底：`splitTurns` 切轮、三条切点硬规则、`defaultThresholdSummary` 机械摘要（并入旧摘要 + 用户原话 + 被裁工具结果清单），新造 `compaction(decidedBy=threshold)` 经 `emitted` 交出 |
| `projection/estimate.ts` | 零依赖 token 粗估：ASCII 4 字一 token、非 ASCII 一字一 token、图片 1600、每事件 +4 固定开销；`estimateTotal` |
| `projection/manifest.ts` | E3c 被折叠工具结果清单：`foldedToolResults` 抽取（入参从 lookup 找、外溢记 blob id）、`digestArgs` 键排序截断、`renderFoldedToolResults` 渲染成 `seq N tool(args) — 大小` |
| `projection/project.ts` | 策略链执行器 `project()` + `defaultProjectionChain()`（四步）+ `DEFAULT_RESERVE_RATIO = 0.15`；入参校验 seq 严格升序，逐策略累计 stats 与 emitted |
| 测试 | `projection.test.ts` 覆盖粗估、四个策略各自的规则、manifest 渲染、supersedes（B3）四种情形、默认链端到端与拒绝条件 |

### `lowering/` — 降级层接口（T7）与 trust 标注（R9）

| 文件 | 职责 |
| --- | --- |
| `lowering/index.ts` | 汇总导出 errors / trust / types |
| `lowering/types.ts` | `Lowering`（capabilities / toRequest / stream）、`ModelRef`、`ToolSpec`、`LoweringCapabilities`、有损矩阵 `LossMatrix` 与落点 `LandingRecord`、`lossesOf()`、`LoweringOutcome`、`BoundModel` |
| `lowering/errors.ts` | `LoweringError` 与 4 种 code（unsupported_model / unsupported_api / missing_api_key / invalid_request） |
| `lowering/trust.ts` | trust 标注纯函数（R9，§14）：`needsUntrustedMark`（`trust === "untrusted"`）、`untrustedSourceOf`（`tool:<name>` → `provenance.source` → actor）、`markUntrusted` / `markUntrustedText`（包成 `<untrusted source=…>…</untrusted>`，只包文本、首尾图片各插一段文本标记）、`escapeUntrustedText`（`</untrusted` → `<\/untrusted`，报 `escaped` 供落点记 lossy）。lowering-pi 与 TanStack 适配器都调这里，不各自拼字符串 |
| 测试 | 无（本目录只有类型；行为由 `@reins/lowering-pi` 的 T8 矩阵测试覆盖） |

### `loop/` — 循环与插座（T9~T11）

| 文件 | 职责 |
| --- | --- |
| `loop/index.ts` | 汇总导出 fork / retry / run-loop / state / static / tools / types |
| `loop/types.ts` | 三组契约：`Tool`（§10 四维）与 `ToolContext`；`Socket` 五钩子 + 两项静态贡献 + `TurnContext`；`RunResult` 四态、`SerializedRunState`、`Interruption`、`LoopConfig`（全部循环开关，P1 加 `announceToolChanges`）；`StaticContribution<T>` 的函数形态可返回 Promise（P1） |
| `loop/run-loop.ts` | `runLoop` 主体（709 行）：append/pause/fail 三个基础动作、恢复与审批校验、每轮投影→钩子→模型→工具→收尾、`endTurn`（含 handoff 建新会话）、`executeToolCalls`、`inputDraft` 白名单 |
| `loop/state.ts` | run 状态：`pendingToolCalls`、`computeConfigHash` / `computePendingDigest`（SHA-256）、`serializeRunState` / `signRunState` / `verifyRunState`（HMAC-SHA256 + 常数时间比较）、`validateResume` 与 8 种 `RunStateError` |
| `loop/static.ts` | `resolveSocketContributions`（P1 起 **async**，各 Socket 依次 await 而非并发）：宿主工具 + 各 Socket 静态工具（同名宿主优先）、系统提示按注册顺序拼接；循环起步与 server 预校验共用，configHash 才对得上 |
| `loop/tools-bound.ts` | P1 纯函数：`lastToolsBound`、`diffToolNames`、`renderToolChangeNote`（给模型的英文文案）、`toolsBoundDrafts`（起步要 append 的 `tools_bound` + 有增删时的 `system_note(kind=host, meta.toolsChanged)`）；runLoop 与 TanStack 适配器共用，两处文案与判定不分叉 |
| `loop/tools.ts` | 工具纯函数：`defineTool`（擦类型以便放进 `Tool[]`）、`toolSpecOf`、`normalizeToolOutput`（string / ContentPart[] / {content,isError} / undefined / 其余 JSON）、`errorMessageOf` |
| `loop/retry.ts` | 瞬断判定与退避（R3 起状态码优先）：`statusFromMessage`（文案开头的三位数字或 "status 503" 写法）、`isTransientFailure`（永久错误 → SDK 连接类名 → `x-should-retry` 头 → 状态码 408/409/429/5xx 与 SDK 同策略 → `code` 精确匹配 → 关键词兜底，裸数字不匹配）、`backoffDelayMs`（base×2^(n−1) 封顶）、`defaultSleep`、`resolveRetry`。 |
| `loop/fork.ts` | `forkSession(log, { fromSessionId, atSeq, toSessionId? })`：薄封装 `EventLog.fork`，只负责缺省新会话 id |
| 测试 | `run-loop.test.ts` 覆盖三轮端到端 / 日志可回放 / 确定性 / Socket 五钩子与静态贡献 / 审批暂停续跑 / 工具各类失败与客户端工具 / 错误·中止·maxTurns·handoff / 瞬断重试 6 例 / 上线前审查修复 3 例 / R1·R2；`run-state.test.ts` 覆盖跨进程暂停恢复与 12 项 fail-closed 校验；`retry.test.ts` 覆盖瞬断判定、退避、可中止 sleep；`fork.test.ts` 覆盖轮边界分叉、切在 tool_call/result 之间、越界拒绝；`upcast-on-read.test.ts` 覆盖循环读日志时升级与不认识的 ext.* 拒绝 |

### `replay/` — 回放（T15）

| 文件 | 职责 |
| --- | --- |
| `replay/index.ts` | 汇总导出 replay |
| `replay/replay.ts` | `replayTurns(timeline, opts)`：按**模型输出类型**（不按 actor）切轮，对每轮请求前的日志前缀重跑 `project`，给出 `visible` / `stats` / `output` / `aftermath` / `usage` / `diverged`；导出 `isModelOutput` |
| 测试 | `replay.test.ts` 覆盖三轮逐字一致、审批暂停期间事件归属、已有 compaction 时 diverged 判定、空时间线、E1 的按输出类型切轮 |

### `testing/` — 一致性套件与脚本化降级层（T5，独立入口）

| 文件 | 职责 |
| --- | --- |
| `testing/index.ts` | `@reins/core/testing` 入口 |
| `testing/harness.ts` | 只要 `{ describe, it }` 的最小 `TestHarness`，自带 `assert` / `assertEqual` / `assertThrowsCode` / `collect`，不绑任何测试框架 |
| `testing/event-log.ts` | `eventLogConformance`：16 条契约（seq 连续性与原子性、区间读、tail、会话隔离、副本语义、fork 四例）+ `makeEvents` 造数助手 |
| `testing/blob-store.ts` | `blobStoreConformance`：字节/字符串往返、meta、id 唯一、not_found、副本语义、可选 slice |
| `testing/memory-store.ts` | `memoryStoreConformance`：缺失返回 null、覆盖写、前缀 list 字典序、delete 幂等、空串与不存在有别 |
| `testing/scripted-lowering.ts` | `ScriptedLowering`：按剧本逐轮吐草稿、记录每轮 `toRequest` 输入、可注入异常与 capabilities；`say` / `think` / `callTool` 草稿速写 |
| 测试 | 无（本目录本身是测试设施，由 `store/in-memory.test.ts` 与 `loop/*.test.ts` 反向验证） |

## 核心流程

### 一、一次 `runLoop` 从起步到四态（`loop/run-loop.ts`）

1. **起步（不写日志）**：`await resolveSocketContributions(cfg)`（可异步：MCP 在此 `tools/list`）把宿主工具与各 Socket 的静态工具、系统提示合成整个 run 不变的两份；`computeConfigHash` 按它们算摘要；`inputDraft(cfg.input)` 过白名单；`readTimeline` 把整条日志过一遍注册表拿到 `lastSeq` —— 以上任一步失败都在写任何东西之前抛。
2. **恢复与审批（校验先于落笔）**：给了 `resume` 就 `validateResume`（形状→会话→签名→configHash→日志不短于状态→pending 对账），`decisions` 逐条确认指向 pending 调用，全过才 append `run_resumed` 与各条 `approval_decision`。 随后 **append 工具表快照**（P1）：一条模型不可见的 `core.tools_bound { toolNames, configHash }`；与日志里上一条比对有增删且 `announceToolChanges !== false`（缺省开）则再 append 模型可见的 `system_note(kind=host)` 列出 Added / Removed，首次 run 不出。
3. **落新输入**：`input` 直接 append，哪怕日志里还有未完成的 tool_call —— 顺序由降级层去满足厂商协议，日志不动。
4. **每轮开头**：读时间线 → 若 `signal.aborted` 立即 `pause("host")`（先于补齐 pending）→ `pendingToolCalls` 非空则先 `executeToolCalls` 补齐、再走一次 `endTurn` 收尾（R2）→ 否则检查 `maxTurns` → `turns++`。
5. **投影与钩子**：`project(timeline)` 得到 view 与 `emitted`；emitted 先 `log.append` 再问模型（模型可见 ⟺ 已记录）；各 Socket 的 `beforeModel` 顺序合并补丁，其间 `ctx.emit` 的草稿 `flush` 落库并（非运维类型）并进本轮视图。
6. **问模型（重试循环）**：每次尝试重新 `toRequest` + `stream`，草稿逐块 append 并 yield；失败时按 `retry.isTransient` 与"本次尝试 `attemptOutput === 0`"共同决定是否重试，要重试就先记一条 `core.error(willRetry)` 再退避；不重试则 `fail()` 返回 error 态。
7. **收尾**：`afterModel` → `executeToolCalls` 处理本轮 tool_call → append `budget_usage`（带 `contextEstimate`）→ 有中断则按 `pauseReasonOf`（审批 > 预算 > 宿主）暂停 → 否则 `endTurn`：第一个给意见的 Socket 决定 continue / stop / pause / handoff，handoff 时旧会话记 `core.handoff`、新会话写入 `system_note(摘要) + intent.opening + user_message(triggerMessage)` 三段开场并回调 `onHandoff`。

### 二、单次工具调用的处置顺序（`executeToolCalls`）

1. 从时间线预扫 `approval_decision` 与 `approval_request`（已批的按批的办，已问过的不重复问）。
2. 已有"拒绝"决定 → 直接 `tool_result(isError)`。
3. `beforeTool` 链：`rewrite` 替换入参后继续问下一个（后续钩子看到改写后的 args），`block` / `defer` 即定；已批准的调用遇到 `defer` 只是略过，后面的钩子仍可 `block`。
4. 未知工具 → isError；**`tool.validate` 在审批之前**（R1），校验不过直接 isError，不惊动审批人。
5. 审批判定：Socket 的 `defer`，或工具自己 `needsApproval` 且无 Socket 做主（`BUILTIN_APPROVAL_POLICY`）→ append `approval_request`（若没问过）并记一条 approval 中断。
6. 无 `execute` 或 `side: "client"` → 记 `client_tool` 中断等宿主回填。
7. `execute` → `toModelOutput` 或 `normalizeToolOutput` → `afterTool` 可整条替换 → `settle()` 先 flush 钩子留痕再 append 结果（每条结果路径都走 settle，留痕永远在结果之前）→ 若宿主已中止则跳出，余下调用留作 pending。

### 三、append 与 seq 乐观并发（`loop/run-loop.ts` 的 `append` + `store/in-memory.ts`）

1. 循环内的 `append(drafts)` 是**唯一**分配 seq 的地方：`lastSeq + 1 + i`，同一批共用一个 `at` 与各自 `newId(at)`。
2. `EventLog.append` 整批先校验（同会话、seq 从末尾 +1 连续）再落盘，任何一条不合即 `StoreError("seq_conflict")` 且整批不写。
3. 于是并发写入者不会静默交错，而是有人拿到冲突 —— 这就是全部的乐观并发控制，SQLite / PG 后端各自用主键唯一约束实现同一语义。

### 四、读时 upcast（`store/read-timeline.ts` + `events/registry.ts`）

1. `readTimeline(log, sessionId, { registry })` 逐条 `registry.read(raw)`：先 `assertBase` 校验壳字段，再查 type，再从 `schemaVersion` 逐级跑 upcaster 到当前版本。
2. 未登记 type、比本地更新的版本、断掉的升级链、抛错的升级函数都抛 `SchemaError`，绝不返回半个事件；日志文件永远存写入时的版本，不做原地迁移。

### 五、投影管线（`projection/project.ts`）

1. `project()` 先校验时间线按 seq 严格升序，算出 `reserveTokens`（缺省窗口 15%）、estimate、registry、now、newId。
2. 逐个策略执行，每个策略拿到新构造的只读 `ProjectionContext`（含完整时间线快照与 `nextSeq()`），返回 `{ events, emitted? }`。
3. 默认链四步：`visibilityFilter` 剔运维事件 → `foldCompactions` 按 compaction 隐藏区间并把摘要插到区间位置 → `reinjectPins` 把幸存 pin 挪到摘要之后 → `budgetTruncate` 超限时按轮裁前缀并新造阈值 compaction。
4. 汇总 `stats`：`estimatedTokens`、`targetTokens`、`overBudget`（裁到只剩最后一轮仍超）与逐步 before/after 计数；`emitted` 交给循环 append。

### 六、fork（`loop/fork.ts` + `store/in-memory.ts`）

1. `forkSession(log, { fromSessionId, atSeq, toSessionId? })` 缺省用 `uuidv7()` 生成目标会话 id。
2. `EventLog.fork` 复制 `[1, atSeq]`，**保留原 id 与 seq，只换 sessionId**，以维持 `parentId` / `pinsKept` / 清单里的 seq 引用；目标会话必须为空，`atSeq` 越界报 `out_of_range`。
3. 若切点落在 `tool_call` 与 `tool_result` 之间，新会话首轮会把那次调用当作 pending 重新执行 —— 有副作用的工具请切在轮边界。

## 核心设计决策

- **时间线只 append，seq 由写入方分配** — `EventLog` 没有 update / delete，压缩、外溢、交接一律以追加事件表达；seq 由 `runLoop` 分配、日志只校验"同会话且从末尾 +1 连续"。为什么：这一条约束同时给出排序真源与乐观并发闸，并发写入者必有一方拿到 `seq_conflict` 而不是静默交错。边界：调用方必须自己保证不跨会话混批，跨进程写同一会话时冲突要靠重读时间线重试。
- **模型可见 ⟺ 已记录** — 投影策略可以新造事件（目前只有阈值 compaction），但必须经 `ProjectionStep.emitted` 交给循环 append，且循环在问模型之前先落库；`beforeModel` 里 `ctx.emit` 的草稿同样先落库再进本轮视图。为什么：这是宪法二在代码里的可执行形式，也是 `replayTurns` 能只凭日志重算每轮视图的前提。边界：Socket 用 `patch.events` 整体替换视图的部分不落日志，因此回放不可重算（`replay.ts` 里如实声明）。
- **读时升级、fail-closed（P9）** — schema 版本登记在 `EventSchemaRegistry`，`read()` 对未登记 type / 未来版本 / 断链 / 升级函数抛错一律 `SchemaError`；`register()` 在登记期就要求 1..n−1 的升级函数齐备。为什么：宁可启动或读第一条时炸掉，也不要读到一半发现日志半新半旧。边界：只校验壳字段，payload 形状由写入方与升级函数负责。
- **暂停是显式返回值，状态只含引用** — `SerializedRunState` 只有 sessionId、lastSeq、pending 调用 id、configHash、pendingDigest（配密钥再加 HMAC-SHA256），内容全部从日志重读，实测不到 400 字节；`validateResume` 的校验顺序是形状→会话→签名→配置→日志长度→pending 对账，全过才写日志。为什么：P6"进程可随时死亡"要求任何事件边界可重入，而恢复路径是攻击面，必须先验后写。边界：不配 `secret` 就不签不验，只适合可信环境；配置漂移默认拒绝，需宿主显式 `allowConfigDrift`。
- **静态贡献与动态补丁分两条路（B2 / B6）** — 模块给模型的工具与规则提示走 `Socket.tools` / `Socket.systemPrompt`（可以是按 `SocketSetup` 算一次的函数），整个 run 逐字不变；每轮的动态改动才走 `beforeModel` 补丁。为什么：prompt cache 要求系统提示与工具表每轮稳定，静态贡献还让续跑补齐 pending 调用时模块工具仍在场。边界：`resolveSocketContributions` 必须被循环起步与 server 预校验**共用**，否则 configHash 对不上、装了模块的会话续跑会被误判成配置漂移。
- **`input` 事件草稿白名单（DECISIONS 2026-09-09）** — `inputDraft` 只接受 `core.user_message` / `core.tool_result` / `core.system_note` / `ext.*`，其余在写任何日志之前抛 `RangeError`。为什么：审查实测一条伪造的 `approval_decision(approved=true)` 就能让 pending 调用免审批执行。边界：审批结论只能走 `decisions`（经 T10 校验）；server 层还有更严的一道。
- **用户插话不改日志顺序（DECISIONS 2026-09-09）** — 日志里有未完成的 tool_call 时，新 `input` 照样追加在当前位置，"tool_result 必须紧跟 tool_use"由降级层把用户消息后移并记 `lossy` 来满足。为什么：什么时候说的就记在什么位置，是宪法二的直接推论；改循环只是把问题挪个地方。边界：这条规则要求每个降级层实现都照做（lowering-pi 与 TanStack 适配器同规则）。
- **瞬断重试只在零输出时（DECISIONS 2026-09-10）** — 模型调用失败且判定为瞬断时最多重试 3 次、1s 起翻倍封顶 8s，但只在**本次尝试一块模型输出都没落日志**时重试；每次将要重试的失败记一条模型不可见的 `core.error(willRetry)`。为什么：时间线只追加，落了半截再重说会让日志里有两份半截，UI / eval / 回放都得猜哪份算。边界：判不出的错误一律当非瞬断（重试 400 只是再挨一次），宿主中止与 `LoweringError` 永不重试；退避不加抖动以保证可回放。
- **入参校验前移到审批之前（R1）** — `beforeTool` 的 rewrite 之后、审批判定之前跑 `tool.validate`，校验不过直接 isError 不问人。为什么：审批人批的必须是将要执行的那份入参，否则 `needsApproval(input: TInput)` 的类型是谎话，也白费一次暂停。边界：`rewrite` 仍在 validate 之前 —— 钩子改的是模型给的原始入参。
- **被打断的轮在续跑后才收尾（R2）** — 循环抽出 `endTurn`，补齐 pending 之后也调一次（缺省 continue）。为什么：被审批或中止打断的那一轮原本永远等不到 `onTurnEnd`，模块在那一轮记下的决定（如 handoff 意图）会整个丢失；修循环比让每个模块各自补救干净。边界：`ctx.timeline` 仍是轮开始时的快照，模块要按日志重建意图。
- **`supersedes` 是撤销一条 pin 的唯一表达（B3）** — 被后来某条 `system_note.supersedes` 指到的事件，一旦被覆盖就不再幸存，不论谁的 `pinsKept` 保留过它；取代者在完整时间线里找，自己被折叠了也算。为什么：append-only 日志里没有"删除"，`pinsKept` 记的是当时的契约，后来的取代说明优先。边界：未折叠时取代不隐藏任何东西，历史原样展示。
- **摘要放在被覆盖区间的位置** — `foldCompactions` 把 compaction 插到区间之后的第一条可见事件前，而不是它自己的 seq 位置，所以投影输出顺序可以与 seq 不一致。为什么：折叠中间段时"摘要出现在原段位置"读起来才顺；视图是给模型看的，日志才按 seq。边界：`budgetTruncate` 因此必须额外守"seq 封闭"，否则新 `coversSeq` 会误伤保留下来的事件。
- **清单与取回用 `tool_result` 的 seq（E3c，DECISIONS 2026-09-10）** — 折叠 / 裁剪时把被折走的工具结果列成 `seq N tool(args) — 大小`，core 只负责列清单（`manifest.ts`），取回的 `recall` 工具在 `@reins/brain`。为什么：摘要写的是模型的取舍，清单写的是事实上还在的东西，两者分开；seq 短、模型能抄，且 fork 后子会话里照样有效。边界：清单缺省最多 80 条，措辞由调用方给（core 不知道取回工具叫什么）。
- **轮边界按模型输出类型而非 actor（E1，DECISIONS 2026-09-09）** — `replayTurns` 与 `splitTurns` 都按 `model_thinking / model_text / tool_call` 三种类型切轮。为什么：脑子模块在工具执行期间留下的事件 actor 也是 `model`，并行工具时按 actor 切会把它们误当成一个新轮。边界：一条模型输出都没回来的失败轮识别不出请求边界，不计入 turns。

## 与技术方案的出入（以代码为准）

1. **§7 说 runLoop "约 600 行（M0 收口实测 578 行含注释）"** —— 实际 `loop/run-loop.ts` 已 **709 行**（后续加了瞬断重试循环与 `endTurn`）。数量级仍符合 P3"几百行、可整个复制"。
2. **§7 的 `TurnContext` 代码块 `budget` 只列 6 个字段** —— 代码有 8 个，多出 `targetTokens`（阈值兜底触发点）与 `lastUsage`（最近一次请求真实用量）。这两个字段在 §9.1 / §9.8 的实现段里有描述，只是 §7 的代码块没同步。
3. **§4 事件表里 `budget_usage` 载荷写"tokens、toolCalls、wallMs、remaining"** —— 代码还有 B8 加的可选 `contextEstimate`（§7 与 §9.8 正文都提到了，表格未同步）。
4. **§10 的 `Tool` 代码块把 `side` 写成必填** —— 代码里 `side?` 可选，缺省 server；同段的 `ToolSource = inProcess | mcp | openapi` 在 core 里并不存在（工具来源由宿主与 `@reins/tools-mcp` 组装）。
5. ~~`core.tools_bound` 事件尚未落地~~ —— 2026-09-10 P1 已落地：`events/core.ts` 16 种，`loop/tools-bound.ts` 纯函数，每次 run 起步一条快照、有增删再一条模型可见说明。
6. **§5 的 `EventLog.append(events: Event[])`** —— 代码签名是 `readonly Event[]`；同理 §8 描述的策略编号（1 过滤 / 2 折叠 / 3 钉住 / 4 感知注入已划掉 / 5 裁剪）在代码注释里原样保留，所以 `truncate.ts` 自称"策略 5"而默认链只有四步，读代码时不必疑惑。
