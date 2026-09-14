# @reinsjs/lowering-fetch 模块盘点

> 以 `packages/lowering-fetch/src/` 代码为准；术语对照 `docs/技术方案.md` §11、决策出处标 `docs/DECISIONS.md`（2026-09-14「lowering-fetch 立项」与「F1 定形」）。

## 1 架构概览

本包是 `@reinsjs/core` 的 `Lowering` 接口的**第二份实现**，只用 `fetch` 与自写的 SSE 解析，`dependencies` 只有 core、零 `node:*`。与 `@reinsjs/lowering-pi` 并存、不替换：宿主 import 谁用谁，总包不带降级层。

三条线协议按 F1 → F2 → F3 顺序实施，当前只有 **OpenAI Chat Completions**（`SUPPORTED_APIS`），`anthropic-messages` / `openai-responses` 在 `resolveModel` 就抛 `unsupported_api`。

翻译分两层，这是理解本包的关键：

- **共用层**（`ir.ts`）：事件 → 中间表示 IR。只做协议无关的三件事——连续 model 事件合成一轮 assistant、"同批 tool_result 必须紧跟 tool_use"的后移、trust 标注。IR 的顺序就是线上顺序。
- **协议层**（`chat/`）：IR → 请求体 + 每条事件的落点；SSE → 事件草稿 + `LoweringOutcome`。F2 / F3 各加一个目录，共用层不动。

与 pi 版最大的差别：**没有第二跳改写**。`LoweredRequest.payload.body` 就是要 POST 的 JSON（鉴权头与 URL 在 `stream` 时才拼，不进 payload，日志不落凭证）。

```
   投影后的 events[] / tools / systemPrompt / ModelRef
                     │
                     ▼
   FetchLowering.toRequest ── resolveModel（宿主 models 优先于内置最小表）── capabilitiesOf
                     │
                     ├─► eventsToIr（ir.ts）：分组 / 后移 / trust 标注 ──► IrItem[]
                     │
                     └─► encodeChatRequest（chat/to-request.ts）：IrItem[] → { body, landings }
                                                   landings 按输入事件顺序排回（orderLandings）
                     │
   LoweredRequest{ capabilities, landings, payload: { api, body } }
                     │
                     ▼
   FetchLowering.stream ── headersFor（bearer / x-api-key / none）── requestSignals（宿主 signal + 超时）
                     │
                     ▼
   postJson（http.ts）── 非 2xx → HttpError("<status> <body>")
                     │
                     ▼
   parseSse（sse.ts）──► consumeChatStream（chat/from-stream.ts）
                              ├─► ctx.onDelta（增量，只给 UI）
                              └─► 收尾产出 CoreEventDraft[] + LoweringOutcome（用量 → core 形状、costOf 算钱）
```

## 2 文件清单

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 公共出口：工厂、`FetchLowering`、`LOSS_MATRIX` / `declaredLandings`、模型表、IR、SSE、HTTP、用量 |
| `src/lowering.ts` | `FetchLowering` 类：`capabilities` / `toRequest` / `stream`；按 `model.api` 分派到协议层；鉴权头与超时信号在这里装配 |
| `src/models.ts` | `FetchModel` 描述（协议、baseUrl、窗口、能力位、价目、`auth`、`chat` 方言）、内置最小表 `BUILTIN_MODELS`（DeepSeek 两款 + 别名、OpenAI Chat 常用四款）、`resolveModel` / `endpointOf` |
| `src/capabilities.ts` | `FetchModel` → `LoweringCapabilities`：Chat 线 `midConversationSystem` 缺省 true、`thinkingReplay` 只在 DeepSeek 方言下为真 |
| `src/factories.ts` | `deepseek()` / `openaiChat()` / `chatCompletions()` → `BoundModel`；`definitionOf` 用内置定义打底、选项覆盖，表外模型从保守缺省起 |
| `src/ir.ts` | 共用遍历器 `eventsToIr`：assistant 分组、`awaiting` / `deferred` 后移、`markUntrusted` 标注、来源判定 `foreignOrigin`；`orderLandings` 把落点排回输入顺序 |
| `src/notes.ts` | `framedSystemNote` / `framedSummary`：说明与摘要落成 user 文本时的框（文案与 pi 版一致） |
| `src/http.ts` | `postJson`（非 2xx 抛 `HttpError`，格式与两家 SDK 同款让 core 的瞬断判据直接可用）、`requestSignals`（宿主 signal 与 `AbortSignal.timeout` 合成，`timedOut()` 区分谁中止的） |
| `src/sse.ts` | `parseSse`：WHATWG SSE 字段子集，兼容 CRLF / 裸 CR / 块切半行 / 末尾无空行 |
| `src/usage.ts` | `ModelCost`（美元 / 百万 token）与 `costOf` |
| `src/chat/to-request.ts` | `encodeChatRequest`：IR → Chat 四角色消息 + tools + `stream_options`；每条事件记落点；`reasoning_content` 方言的写侧 |
| `src/chat/from-stream.ts` | `consumeChatStream`：chunk 拼块（`reasoning_content` / `content` / 按 index 拼 `tool_calls`）、`finish_reason` → `stopReason`、`usageOf` 换算、中断 / 超时 / 网络错的收尾 |
| `src/chat/loss-matrix.ts` | `CHAT_LOSS_MATRIX` 与共用的 `NOT_SENT`：Chat 线的有损合同 |
| 测试（8 个 `*.test.ts`，120 例） | `sse` / `http`（含与 core `isTransientFailure` 的对接）/ `ir` / `chat/to-request` / `chat/from-stream` / `chat/loss-matrix`（三个目标 × 24 变体 + 死条目）/ `factories` / `lowering`（假 fetch 全链 + 一条真跑 core `runLoop` 的多轮集成） |

## 3 核心流程

### 3.1 `eventsToIr`：分组与后移

1. 顺序遍历事件。连续的 model 事件（`model_thinking` / `model_text` / `tool_call`）攒进同一个 group；遇到 user / tool_result / system_note / compaction 或来源（replay 的 provider / api / model）变了就 `flush()` 成一条 `assistant` item，并把其中 tool_call 的 id 记进 `awaiting`。运维事件（`dropped`）**不打断分组**——模型看不见它，它就不该切开模型的一轮输出。
2. `awaiting` 非空时到来的 user / system_note / compaction 进 `deferred`，item 标 `deferred: true`；每条 tool_result 从 `awaiting` 删一个，清空即按原顺序放出。新的模型输出到来（视图切在结果之前、这批结果不会再来了）与收尾也放出。
3. trust 标注调 core 的 `markUntrusted` / `markUntrustedText`（与 pi 版、TanStack 适配器同一份纯函数），转义过的标 `escaped`。
4. IR 只提供事实（deferred / escaped / 来源），exact 还是 lossy 由协议层判。

### 3.2 `encodeChatRequest`：IR → Chat 请求体

- `systemPrompt` → 首条 `system`。`system_note` → 中途 `system`（`capabilities.midConversationSystem`，Chat 缺省 true），否则 `<system_note kind=…>` 框住走 user（lossy user-role）。`compaction` → `[Summary of earlier conversation]` user 文本（lossy user-text）。
- user：单段文本用字符串，否则 content parts；图片走 `data:` URL，模型不收图时换占位文本并记 lossy。
- assistant：正文多段合并成一个字符串（DeepSeek 只接受 string | null，lossy merged-text）；`tool_calls[].function.arguments` 是 JSON 字符串（读侧解析失败存下的原始字符串原样送回）；**方言开着时 `reasoning_content` 字段必在**——同家 thinking 拼进去，没有就空串（DeepSeek 带 tools 时缺字段 400，2026-09-14 实测），别家 thinking 记 dropped；方言关着不带字段、thinking 记 dropped。
- tool：`{ role: "tool", tool_call_id, content: string }`；只收文本，图片换占位（lossy tool-text-only）；`isError` 没有位可放，以 `[tool error]\n` 前缀表达（lossy）。
- 请求体：宿主 `requestOptions` 先铺，`model` / `messages` / `tools` / `stream: true` / `stream_options.include_usage` 后盖。
- 落点最后 `orderLandings` 排回输入顺序（`LoweredRequest.landings` 的契约；pi 版后移项是乱序的，本包修正）。

### 3.3 `stream`：请求 → 草稿

1. `headersFor`：`auth` 缺省按协议（Chat / Responses bearer、Anthropic x-api-key），`"none"` 时不问 `apiKey` 回调（凭证在 headers，如 CF 网关）；缺 key 抛 `LoweringError("missing_api_key")`（core 判永久、不重试）。
2. `requestSignals`：宿主 signal 与 `AbortSignal.timeout(timeoutMs)` 用 `AbortSignal.any` 合成；宿主中止优先。
3. `postJson`：非 2xx 读完正文抛 `HttpError`，`message` 是 `"<status> <body>"`、对象带 `status` / `headers`——core 的 `isTransientFailure` 先看 `status`（408 / 409 / 429 / 5xx 重试）、再看 `x-should-retry`，不用任何额外约定。网络错误由 fetch 原样上抛（`cause.code` 保留）。
4. `consumeChatStream`：按 chunk 拼块，`[DONE]` 收尾；坏 JSON 帧跳过。收尾时才产草稿（与 pi 版同策略），增量只经 `onDelta`（块序号按首次出现分配）。
5. `stopReason`：有 tool_call 即 `toolUse`（强制 tool_choice 时官方 finish 是 stop，F0 实测）；`length` → length；`content_filter` / `insufficient_system_resource` / `aborted` → error 并把原因写进 `errorMessage`（资源不足那条写明 temporarily unavailable，让 core 判可重试）；没 `[DONE]` 也没 finish → error "stream ended before finish_reason"（core 判可重试）。
6. 读流中途出错：先交出已拼的草稿，再按 `signal.aborted` → `aborted`、`timedOut()` → error（timed out）、其它 → error（错误文案 + cause.code）。
7. 用量：`input = prompt_tokens − cached_tokens`（core 语义：input 是未命中数），`cacheRead = cached_tokens ?? prompt_cache_hit_tokens`；`costOf` 按模型价目算 `costUsd`（没价目就缺省）。

## 4 核心设计决策

**共用层只产 IR，不产协议消息** — pi 版的中间层是 pi-ai 的三角色 `Message[]`，协议细节（system 角色缺失、缓存断点）漏到第二跳靠 `onPayload` 改写。这里 IR 只记事实（分组、后移、转义、来源），三条协议各自从 IR 编码，没有第二跳。边界：IR 的 `dropped` item 顺序无意义，只用于记落点。

**`payload.body` 就是线上请求体** — 排查 400 直接看它；也让 lazy-tools 的 provider 原生路径（改请求整形）成为可能。边界：URL 与鉴权头不在 payload 里，要看它们用假 fetch 截。

**Chat 方言只收 DeepSeek 的 `reasoning_content`，且写侧"字段必在"**（DECISIONS 2026-09-14 F1 定形）— 立项时只打算读侧；实测 DeepSeek 带 `tools` 的请求里每条历史 assistant 都必须带该字段（缺了 400、空串可过），不做写侧就没法跑多轮工具。方言用 `FetchModel.chat.reasoningContent` 开关，`deepseek()` 缺省开、`openaiChat()` 不带。边界：别家模型产的 thinking 不回填（记 dropped），字段仍以空串在场。

**内置模型表是最小表，宿主可覆盖任何字段** — 表过期不阻塞使用：`definitionOf` 用内置定义打底、选项覆盖，表外模型从保守缺省起并要求 `baseUrl`。价目是 2026-09-14 查阅的公开价，DeepSeek 存峰值价（谷时减半），`costUsd` 是估算上限。

**错误文案对齐官方 SDK 格式，不另造重试约定** — `HttpError` 的 `message` 是 `"<status> <body>"`、对象带 `status` / `headers`，core 的判据（R3）原样适用；超时用 `AbortSignal.timeout` 抛的 `TimeoutError`，其文案含 timeout、core 判可重试；宿主中止是 `AbortError`，不重试。

**落点按输入顺序排回** — core 的 `LoweredRequest.landings` 承诺"顺序与输入一致"，后移会打乱记录顺序，所以 encoder 记完再 `orderLandings`。矩阵测试断言 `landings[i].eventId === events[i].id`。

**Chat 线的四处有损如实进矩阵** — thinking 无回放位（dropped）、多段正文合并（merged-text）、tool 消息只收文本且无错误位（tool-text-only / `[tool error]` 前缀）、无显式缓存断点（不做任何事，靠厂商自动前缀缓存、`cached_tokens` 记 cacheRead）。宁可声明有损，不静默丢。

**`auth: "none"`** — CF 网关这类自带凭证头的上游不该被 `missing_api_key` 挡住，也不该被塞一个 `Authorization: Bearer` 头（F0 实测带了会失败）。模型级声明，工厂里 `apiKey` 可给空串占位。
