# @reinsjs/ui-agui 模块盘点

> 以 `packages/ui-agui/src/` 代码为准；术语对照 `docs/技术方案.md` §12，决策出处标 `docs/DECISIONS.md`（T13）。

## 1 架构概览

本包把 reins 的时间线事件翻成 **AG-UI 协议事件**。它只是一层翻译（宪法二：时间线是唯一真源，前端协议不反过来定义事件），分两个层次：

- **`mapEvent`**（`map-event.ts`）：纯函数、无状态，一条**完整**事件 → 零到多条 AG-UI 事件。可以脱离 server 单独用（比如把一段历史日志渲染成 AG-UI 流）。
- **`createAguiEncoder`**（`encoder.ts`）：**一条流一个实例**、有状态，吃 `@reinsjs/server` 的 `StreamItem`（含流式增量），吐 `SseFrame[]`。`aguiEncoding()` 是它的工厂形态，直接塞进 `createAgentHandler(agent, { encode: aguiEncoding() })`。

运行时对第三方零依赖：AG-UI 的事件形状在 `types.ts` 里按 `@ag-ui/core` 0.0.59 的 zod schema **手抄成本地类型**，官方包只作 devDependency 在测试里逐条校验，不把 zod 带给用户。（package.json 里 `@reinsjs/core` 是真实运行时依赖 —— `uuidv7`；`@reinsjs/server` 只被 `import type` 用到。）

```
  @reinsjs/server 的一条 SSE 流
        │
        │ StreamItem
        ▼
  createAguiEncoder()  ── 每条流一个实例，状态 = { threadId, runId, open, parentMessageId }
        │
        ├─ start   ─────────────────────────────────► RUN_STARTED
        ├─ delta   ─► onDelta ─► 开/续"正在流的块" ──► TEXT_* / REASONING_*（tool_args 丢弃）
        ├─ event   ─► onEvent ─┬─ 与 open 同类 → 只补 END（沿用增量的 messageId）
        │                      └─ 否则 closeOpen() + mapEvent(event, { parentMessageId })
        ├─ result  ─► closeOpen() + RUN_FINISHED(success|interrupt) / RUN_ERROR
        ├─ end     ─► closeOpen() + RUN_FINISHED(success, result=replayed)
        └─ error   ─► closeOpen() + RUN_ERROR
        │
        ▼
  frames()：SSE 的 id: (= seq) 只挂在一个时间线事件翻出的**最后一帧**上
```

## 2 文件清单

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 公共出口：`mapEvent` / `AGUI_MAPPING` / `partsToText` / `reinsMetadata`、`createAguiEncoder` / `aguiEncoding`、以及 `types.ts` 的全部类型 |
| `src/types.ts` | AG-UI 协议事件的本地类型（本包用到的子集）、`AguiInterrupt` / `AguiRunOutcome`、挂在每条事件上的 `ReinsMetadata` |
| `src/map-event.ts` | 映射表 `AGUI_MAPPING` 与纯函数 `mapEvent`；`partsToText` 把内容片段压成文本并记 dropped，`reinsMetadata` 生成 `metadata.reins` |
| `src/encoder.ts` | 有状态编码器：增量与完整事件接成同一条消息、`parentMessageId` 维护、run 四态收尾、`interruptsOf` 把 core 的 `Interruption` 翻成 AG-UI interrupt、SSE 帧的 id 归属 |
| `demo/index.html` | 无依赖的最小页面：直连 SSE、按 AG-UI 事件渲染 |
| `demo/serve.mjs` | 最小演示服务（node:http + `createAgentHandler` + `aguiEncoding()`），无密钥时用 core testing 的剧本假模型离线跑 |
| 测试（2 个 `*.test.ts`） | `map-event.test.ts` 逐种事件核对映射表与字段细节；`encoder.test.ts` 测增量与完整事件接成同一条消息、run 结束的三种翻译、以及接上 `@reinsjs/server` 的端到端 |

## 3 核心流程

### 3.1 映射表（`mapEvent`，一条完整事件）

| 时间线事件 | AG-UI 事件（按顺序） |
| --- | --- |
| `core.user_message` | `TEXT_MESSAGE_START`(role=user) → `TEXT_MESSAGE_CONTENT` → `TEXT_MESSAGE_END` |
| `core.model_text` | `TEXT_MESSAGE_START`(role=assistant) → `TEXT_MESSAGE_CONTENT` → `TEXT_MESSAGE_END` |
| `core.model_thinking` | `REASONING_START` → `REASONING_MESSAGE_START` → `REASONING_MESSAGE_CONTENT` → `REASONING_MESSAGE_END` → `REASONING_END` |
| `core.tool_call` | `TOOL_CALL_START` → `TOOL_CALL_ARGS`（整段 JSON，不分片）→ `TOOL_CALL_END` |
| `core.tool_result` | `TOOL_CALL_RESULT`（role=tool） |
| `core.system_note` / `approval_request` / `approval_decision` / `compaction` / `handoff` / `memory_op` / `budget_usage` / `run_paused` / `run_resumed` / `core.error` / `ext.*` | `CUSTOM`（`name` = 事件 type，`value` = 事件本身） |

1. `messageId` 一律取 `event.id`；`timestamp` 取 `event.at`；每条都带 `metadata.reins = { seq, eventId, type, dropped? }`，客户端据此去重或定位回时间线。
2. **没有任何事件被丢弃**：`switch` 的 `default` 分支兜底成 `CUSTOM`，所以新增事件类型不会静默消失，只是前端可能不认识。
3. 空正文不造空帧：`model_text` / `user_message` 文本为空时不发 `TEXT_MESSAGE_CONTENT`；`model_thinking` 文本为空（加密 reasoning 只有 replay 没正文）时只发 `REASONING_START` + `REASONING_END`，让前端知道"这里想过"。
4. 内容片段只有文本能进 AG-UI 正文：`partsToText` 把图片换成 `[图片 <mime>]` 占位并在 `metadata.reins.dropped` 里记 `image:<mime>`（P7 有损必声明）。
5. `tool_result` 的 `isError` / `spilled` 在 AG-UI 没有对应字段，塞进 `metadata.reins` 不丢。

### 3.2 流式：增量与完整事件接成一条消息

1. `onDelta` 只处理 `text` / `thinking`，**`tool_args` 增量直接丢弃**（返回空数组）—— 增量里没有 toolCallId 与工具名，凑不出 `TOOL_CALL_START`；参数等完整 `tool_call` 事件到达时一次给出。空 delta 也丢弃。
2. 第一片增量：`closeOpen()` 收掉上一个块，`newMessageId()`（缺省 `uuidv7`）开一个**临时 id**，发 `TEXT_MESSAGE_START` + `CONTENT`（或 `REASONING_START` + `MESSAGE_START` + `CONTENT`），并把 `{ kind, index, messageId }` 记进 `open`。后续同 kind 同 index 的片只发 `CONTENT`。
3. `onEvent` 收到与 `open` 同类的完整 `core.model_text` / `core.model_thinking` 时，**只补 END**，`messageId` 沿用增量开出的那个（此时 `metadata.reins` 才带上真实 seq 与事件 id）。不同类的事件先 `closeOpen()` 再走 `mapEvent`，不留半截消息。
4. `parentMessageId`：`core.user_message` 到达即重置为 undefined；完整 `core.model_text` 设为事件 id，增量开出的文本块设为那个临时 id；随后的 `tool_call` 用它做 `parentMessageId`。

### 3.3 run 收尾与 SSE 帧

1. `result` 帧：`status === "error"` → `RUN_ERROR`（message 取 `r.error.payload.message`，code 取 `payload.category`）；`paused` → `RUN_FINISHED` 且 `outcome = { type: "interrupt", interrupts }`；其余（`done` / `handoff`）→ `RUN_FINISHED` + `outcome.success`。**完整的 `RunResult`（含 paused 的 state）原样放在 `result` 字段里**，供前端回传续跑。
2. `interruptsOf` 一一对应 core 的 `Interruption`：`approval` 带 `toolCallId` / `request.summary` / `metadata.policyId`，`client_tool` 带 `toolCallId` 与 `call`，`subagent`（子代理冒泡）带 `toolCallId` 与 `metadata.{ childSessionId, childReason, interruptions, state }`——前端答子的审批时把 `childSessionId` 放进 `decisions[].sessionId`，其余种类（budget / host…）合成 `id = "<kind>:<lastSeq>:<n>"`。
3. `end` 帧（GET 补发、本进程没有在跑的 run）也翻成 `RUN_FINISHED(success)`，`result` 是一条合成的 `{ status: "replayed", sessionId, lastSeq }`。
4. `frames()` 只给一批事件的**最后一帧**挂 `id: String(seq)`，这样 `Last-Event-ID` 永远指向已完整送达的时间线事件，重连不会从半条消息中间接上。控制帧（RUN_STARTED / RUN_FINISHED / RUN_ERROR）不带 id。

## 4 核心设计决策

**只翻译不发明** — 能用 AG-UI 原生事件表达的（文本、推理、工具调用与结果、run 生命周期）用原生；reins 特有的（system_note、compaction、审批、预算、暂停恢复、`ext.*`）一律 `CUSTOM`，`name` = 事件 type、`value` = 事件本身（T13，DECISIONS 2026-09-08）。前端协议是翻译层，不该反过来定义事件。边界：审批弹窗这类交互靠前端识别 `core.approval_request` 自己实现，本包不提供 UI 语义。

**AG-UI 类型手抄，官方包只进测试** — `types.ts` 按 `@ag-ui/core` 0.0.59 的 zod schema 抄成本地类型，官方包作 devDependency 在测试里逐条校验产出（T13）。为的是运行时零依赖，不把 zod 带给用户。边界：上游 schema 变了要靠测试发现，本地类型得手工跟。

**每条事件带 `metadata.reins`** — `{ seq, eventId, type, dropped? }` 让任何 AG-UI 客户端都能把渲染出来的消息对回时间线（去重、定位、重连）。边界：AG-UI 原生字段装不下的 reins 信息（`isError`、`spilled`、图片占位）也走这里，属约定而非协议。

**编码器是按流的工厂** — `aguiEncoding()` 返回 `StreamEncoderFactory`，server 每开一条流调用一次（T13；`@reinsjs/server` 的 `StreamEncoderFactory` 注释同样写明）。因为把增量与随后的完整事件接成同一条消息必须有状态，而多条流会并发交错，状态必须按流隔离。边界：`mapEvent` 本身仍是纯函数，不想要状态的场景可以只用它。

**tool_args 增量丢弃** — 增量里没有 toolCallId 与工具名，凑不出 `TOOL_CALL_START`（`encoder.ts` 注释、T13）。边界：前端看不到工具参数的逐字流出，要等完整 `core.tool_call` 事件一次拿到整段 JSON。

**SSE 的 id 只挂最后一帧** — 一个时间线事件翻出多帧时，只有最后一帧带 `id: seq`（T13）。这样 `Last-Event-ID` 永远指向已完整送达的事件，客户端重连不会从消息中间接上。边界：由 `frames()` 统一处理，控制帧不带 id。

**paused 翻成 interrupt 且带回完整 state** — run 四态里 `done` / `handoff` → `RUN_FINISHED(success)`，`paused` → `RUN_FINISHED(interrupt)` 且 interrupts 一一对应 `Interruption`、完整 `RunResult`（含 state）放 `result` 供前端回传，`error` → `RUN_ERROR`（T13）。边界：AG-UI 没有"暂停"这个态，用 `outcome.interrupt` 表达是我们的约定；前端不回传 state 就续不上。
