# @reinsjs/lowering-fetch 模块盘点

> 以 `packages/lowering-fetch/src/` 代码为准；术语对照 `docs/技术方案.md` §11、决策出处标 `docs/DECISIONS.md`（2026-09-14「lowering-fetch 立项」「F1 定形」，2026-09-15「F2 定形」「F3 定形」）。

## 1 架构概览

本包是 `@reinsjs/core` 的 `Lowering` 接口的**第二份实现**，只用 `fetch` 与自写的 SSE 解析，`dependencies` 只有 core、零 `node:*`。与 `@reinsjs/lowering-pi` 并存、不替换：宿主 import 谁用谁，总包不带降级层；**新宿主推荐本包**（DECISIONS 2026-09-15「F4 收口」），选择指南在两份 README。

**L1（2026-09-15）**：Anthropic 线加原生延迟加载——`ToolSpec.deferLoading` → `defer_loading: true`、system 信任结果里的 `tool_reference` 段 → `tool_reference` 块（厂商就地展开、工具表整段不变）；能力位 `deferredTools` 对 `provider: "anthropic"` 缺省真、第三方由 `anthropic.deferredTools` 声明；Chat / Responses 线把引用段展开成文本、不发 deferLoading 的工具。厂商规矩与数字见 `spikes/l1-deferred-tools/`。

**状态（F4 收口，2026-09-15）**：F1～F3 三条线各臂真模型全通；`pnpm check:dist` 登记全部工厂导出；`spikes/edge-runtime-check` 的 `/fetch-*` 五条探测在 workerd 三档 × 五格 15/15——最严档（2023 compat date，`process` / `Buffer` 不存在、`node:*` import 失败）上三条线各打一次真模型（DeepSeek 直连 / CF 网关 Haiku 4.5 / CF 网关 gpt-5-mini），判据是产出内容。dist 约 90 KB ESM。changeset（minor）已备，随下次 `changeset version` 发布。

三条线协议按 F1 → F2 → F3 顺序实施，**OpenAI Chat Completions**、**Anthropic Messages**、**OpenAI Responses** 均已实现（`SUPPORTED_APIS`）；宿主声明了别的协议名在 `resolveModel` 就抛 `unsupported_api`。

翻译分两层，这是理解本包的关键：

- **共用层**（`ir.ts`）：事件 → 中间表示 IR。只做协议无关的三件事——连续 model 事件合成一轮 assistant、"同批 tool_result 必须紧跟 tool_use"的后移、trust 标注。IR 的顺序就是线上顺序。
- **协议层**（`chat/`、`anthropic/`、`responses/`）：IR → 请求体 + 每条事件的落点；SSE → 事件草稿 + `LoweringOutcome`。三个目录互不依赖，共用层从 F1 起没动过。

与 pi 版最大的差别：**没有第二跳改写**。`LoweredRequest.payload.body` 就是要 POST 的 JSON（鉴权头与 URL 在 `stream` 时才拼，不进 payload，日志不落凭证）。Anthropic 的中途 system 归位、缓存断点这些 pi 版只能在 `onPayload` 外挂补的事，这里直接在 encoder 里做。

```
   投影后的 events[] / tools / systemPrompt / ModelRef
                     │
                     ▼
   FetchLowering.toRequest ── resolveModel（宿主 models 优先于内置最小表）── capabilitiesOf
                     │
                     ├─► eventsToIr（ir.ts）：分组 / 后移 / trust 标注 ──► IrItem[]
                     │
                     ├─► openai-chat        → encodeChatRequest（chat/to-request.ts）
                     ├─► anthropic-messages → encodeAnthropicRequest（anthropic/to-request.ts）
                     └─► openai-responses   → encodeResponsesRequest（responses/to-request.ts）
                                                 → { body, landings }，landings 按输入事件顺序排回（orderLandings）
                     │
   LoweredRequest{ capabilities, landings, payload: { api, body } }
                     │
                     ▼
   FetchLowering.stream ── headersFor（bearer / x-api-key / none；Anthropic 加 anthropic-version、按需 anthropic-beta）
                        ── requestSignals（宿主 signal + 超时）
                     │
                     ▼
   postJson（http.ts）── 非 2xx → HttpError("<status> <body>")
                     │
                     ▼
   parseSse（sse.ts）──► consumeChatStream / consumeAnthropicStream / consumeResponsesStream
                              ├─► ctx.onDelta（增量，只给 UI）
                              └─► 收尾产出 CoreEventDraft[] + LoweringOutcome（用量 → core 形状、costOf 算钱）
```

## 2 文件清单

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 公共出口：工厂、`FetchLowering`、`LOSS_MATRIX`（三张表）/ `declaredLandings`、模型表、IR、SSE、HTTP、用量、三条线的 encoder / consumer 与请求体类型 |
| `src/lowering.ts` | `FetchLowering` 类：`capabilities` / `toRequest` / `stream`；按 `model.api` 分派到三个协议层；鉴权头（Chat / Responses bearer、Anthropic x-api-key）、`anthropic-version` / `anthropic-beta` 与超时信号在这里装配；`ANTHROPIC_VERSION` |
| `src/models.ts` | `FetchModel` 描述（协议、baseUrl、窗口、能力位、价目、`auth`、`chat` / `anthropic` / `responses` 方言）、`AnthropicDialect`（`betas` / `cacheBreakpoints` / `cacheTtl` / `midSystemCacheBreakpoint` / `deferredTools`）、`ResponsesDialect`（`systemRole` / `encryptedReasoning`）、内置最小表 `BUILTIN_MODELS`（Anthropic 五款 + 别名、OpenAI Responses 十三款、DeepSeek 两款 + 别名、OpenAI Chat 四款；同 id 两协议各一份，Responses 条目在前）、`findBuiltin(provider, id, api?)` / `resolveModel` / `endpointOf` |
| `src/capabilities.ts` | `FetchModel` → `LoweringCapabilities`：Chat 线 `midConversationSystem` 缺省 true、`thinkingReplay` 只在 DeepSeek 方言下为真；Anthropic 线 `midConversationSystem` 按模型族正则（Fable 5.x / Mythos 5.x / Opus 5 / Opus 4.8）或宿主声明、`thinkingReplay = reasoning`、`taskBudget` Opus 5 / Fable 5.1、`deferredTools` 缺省 `provider === "anthropic"`（L1；其余两线恒假）；Responses 线 `midConversationSystem` 缺省 true、`thinkingReplay = reasoning && encryptedReasoning !== false` |
| `src/factories.ts` | `deepseek()` / `openaiChat()` / `chatCompletions()` / `anthropic()` / `anthropicMessages()` / `openai()` / `openaiResponses()` → `BoundModel`；`definitionOf(provider, id, api, opts)` 按协议精确取内置定义打底、选项覆盖（方言对象按键合并），表外模型从保守缺省起（`openai()` 对表外新型号按推理 / 收图起）；`ModelOptions` / `ProviderModelOptions`（旧名 `ChatModelOptions` / `ChatCompletionsOptions` 保留为别名） |
| `src/ir.ts` | 共用遍历器 `eventsToIr`：assistant 分组、`awaiting` / `deferred` 后移、`markUntrusted` 标注、来源判定 `foreignOrigin`；`orderLandings` 把落点排回输入顺序 |
| `src/notes.ts` | `framedSystemNote` / `framedSummary`：说明与摘要落成 user 文本时的框（文案与 pi 版一致） |
| `src/http.ts` | `postJson`（非 2xx 抛 `HttpError`，格式与两家 SDK 同款让 core 的瞬断判据直接可用）、`requestSignals`（宿主 signal 与 `AbortSignal.timeout` 合成，`timedOut()` 区分谁中止的） |
| `src/sse.ts` | `parseSse`：WHATWG SSE 字段子集，兼容 CRLF / 裸 CR / 块切半行 / 末尾无空行 |
| `src/usage.ts` | `ModelCost`（美元 / 百万 token）与 `costOf` |
| `src/chat/to-request.ts` | `encodeChatRequest`：IR → Chat 四角色消息 + tools + `stream_options`；每条事件记落点；`reasoning_content` 方言的写侧；宿主 `requestOptions.tools` 剥掉 |
| `src/chat/from-stream.ts` | `consumeChatStream`：chunk 拼块、`finish_reason` → `stopReason`、`usageOf` 换算、中断 / 超时 / 网络错的收尾 |
| `src/chat/loss-matrix.ts` | `CHAT_LOSS_MATRIX` 与两线共用的 `NOT_SENT` |
| `src/anthropic/to-request.ts` | `encodeAnthropicRequest`：IR → `{ system[], messages[], tools[], max_tokens, stream }`；中途 system 归位（攒到下一条 assistant 之前 / 收尾，否则退 user 文本）；连续 user 侧内容并进同一条 user；thinking 签名回放 / redacted / dropped；tool_use 非对象入参包 `{ value }`；`placeCacheBreakpoints` 打三处断点（tools 那处落在最后一个非延迟工具上）+ 说明殿后处置 + 封顶 4；宿主 `requestOptions.system/tools` 剥掉；`MAX_ANTHROPIC_BREAKPOINTS` / `countBlockBreakpoints`；**L1**：`encodeTools`（deferLoading → `defer_loading`，全表延迟时不延迟；无能力位则不发），tool_result 分支——system 信任 + 引用全在表里 → `tool_reference` 块、文本段攒进 `asides` 在 `closeUser` 时插到这批 tool_result 之后（lossy `tool-reference`），否则 `blocksOf` 把引用展开成文本（未绑定 lossy / untrusted exact 带备注） |
| `src/anthropic/from-stream.ts` | `consumeAnthropicStream`：按 `data.type` 分派 message_start / content_block_start / delta（text / thinking / signature / input_json）/ message_delta / message_stop / error；收尾按 index 出草稿（空正文带签名的 thinking 也出，`redacted_thinking` 出 pi 同款草稿）；`stop_reason` 映射（refusal → error 带 stop_details）；`usageOf`（input 即未命中、cache_read / creation → cacheRead / cacheWrite） |
| `src/anthropic/loss-matrix.ts` | `ANTHROPIC_LOSS_MATRIX`：Anthropic 线的有损合同，与 pi 版同名表逐格对照；L1 多两格 `tool-reference`（exact 纯引用 / lossy 引用 + 文本） |
| `src/responses/to-request.ts` | `encodeResponsesRequest`：IR → `{ input[], tools?, stream, store: false, include? }`；系统提示与说明是任意位置的 developer / system 消息；assistant 一轮拆成多个项（`type:message` 带 id / phase、整个 reasoning 项原样、`function_call` 带 call_id 与可选 fc_ 项 id）；`function_call_output` 三形态（字符串 / `[tool error]` 前缀 / 带图片的内容块数组）；宿主 `input` / `tools` / `previous_response_id` 剥掉；`reasoningItemOf` 判可回放 |
| `src/responses/from-stream.ts` | `consumeResponsesStream`：按 `type` 分派 `response.output_item.added/done`、`reasoning_summary_part.added` / `reasoning_summary_text.delta` / `reasoning_text.delta`、`output_text.delta` / `refusal.delta`、`function_call_arguments.delta/done`、`response.completed/incomplete/failed`、`error`；按 output_index 存槽、项收尾以厂商最终形状为准、`completed.output` 回填加密项；`usageOf`（input 减 cached 与 cache_write） |
| `src/responses/loss-matrix.ts` | `RESPONSES_LOSS_MATRIX`：Responses 线的有损合同，与 pi 版同名表逐格对照 |
| 测试（14 个 `*.test.ts`，394 例） | `sse` / `http` / `ir` / `chat/*`（三个目标 × 24 变体 + 死条目）/ `anthropic/to-request`（S1 五种摆放、断点三档、签名四种来源）/ `anthropic/from-stream` / `anthropic/loss-matrix`（三个目标 × 30 变体 + 死条目）/ `responses/to-request`（骨架、角色、requestOptions 剥盖、reasoning 五种来源、正文 id 四种来源、两个 id、输出三形态、说明任意位置、后移）/ `responses/from-stream` / `responses/loss-matrix`（三个目标 × 34 变体 + 死条目 + 与 pi 版对照）/ `factories` / `lowering`（假 fetch 全链、三条线各一条真跑 core `runLoop` 的多轮集成） |

## 3 核心流程

### 3.1 `eventsToIr`：分组与后移

1. 顺序遍历事件。连续的 model 事件（`model_thinking` / `model_text` / `tool_call`）攒进同一个 group；遇到 user / tool_result / system_note / compaction 或来源（replay 的 provider / api / model）变了就 `flush()` 成一条 `assistant` item，并把其中 tool_call 的 id 记进 `awaiting`。运维事件（`dropped`）**不打断分组**。
2. `awaiting` 非空时到来的 user / system_note / compaction 进 `deferred`，item 标 `deferred: true`；每条 tool_result 从 `awaiting` 删一个，清空即按原顺序放出。新的模型输出到来与收尾也放出。
3. trust 标注调 core 的 `markUntrusted` / `markUntrustedText`（与 pi 版、TanStack 适配器同一份纯函数），转义过的标 `escaped`。
4. IR 只提供事实（deferred / escaped / 来源），exact 还是 lossy 由协议层判。

### 3.2 `encodeChatRequest`：IR → Chat 请求体

- `systemPrompt` → 首条 `system`。`system_note` → 中途 `system`（缺省 exact），否则 `<system_note kind=…>` 框住走 user（lossy user-role）。`compaction` → `[Summary of earlier conversation]` user 文本（lossy user-text）。
- user：单段文本用字符串，否则 content parts；图片走 `data:` URL，模型不收图时换占位文本并记 lossy。
- assistant：正文多段合并成一个字符串（lossy merged-text）；`tool_calls[].function.arguments` 是 JSON 字符串；**方言开着时 `reasoning_content` 字段必在**。
- tool：只收文本，图片换占位（lossy tool-text-only）；`isError` 以 `[tool error]\n` 前缀表达（lossy）。
- 请求体：宿主 `requestOptions` 先铺（`tools` 剥掉），`model` / `messages` / `tools` / `stream` / `stream_options` 后盖。

### 3.3 `encodeAnthropicRequest`：IR → Anthropic 请求体（F2）

1. **user 侧合并**：user / tool_result / compaction / 不支持中途 system 时的说明，都追加到"正在攒的 user 消息"（`userRun`）；遇到 assistant 或放出说明时收口成一条 `{ role: "user", content: [...] }`。这样同批 tool_result 与被 IR 后移的用户消息天然并在同一条 user 里（F0 A5b 实测可达）。空文本段跳过；整条没有任何块就不发并记 dropped。
2. **说明归位**：支持中途 system 时，`system_note` 进 `pendingNotes`，等到下一条 assistant 之前（或收尾）才放出。放出时看 `messages` 末条：是 user / system → 逐条 `{ role: "system", content: [text] }`，exact（转义过 lossy；被 IR 后移或位置晚了一条 user 的加备注）；是 assistant 或什么都没有 → 全部框成一条 user 文本，lossy(user-role) 并写明原因。有说明在等而又来了 user 侧内容 → 标 `moved`。
3. **assistant**：先算内容块，全部块都发不出（如只有无签名 thinking）就整条不发、也不切开 user 侧合并；否则先放出说明再 push。块：text 原样（空段 dropped）；thinking 看 `replay.thinkingSignature`——别家 dropped、无签名 dropped、`redacted` → `redacted_thinking(data)`、否则 `thinking(thinking, signature)`（同家不同型号加备注）；tool_call → `tool_use`，非对象入参包 `{ value }`（lossy wrapped-args）。
4. **请求体**：宿主 `requestOptions` 先铺（`system` / `tools` 剥掉），`model` / `max_tokens`（宿主没给取 `maxOutputTokens`）/ `messages` / `stream: true` 后盖；`systemPrompt` → `system: [{ type: "text", text }]`；`tools[].input_schema` 直接透传 JSON Schema。
5. **缓存断点**（`anthropic.cacheBreakpoints !== false`）：`{ type: "ephemeral" }`（`cacheTtl: "1h"` 时带 ttl）打在 system 末块、tools 末项、最后一条 user 的末块；末条是 system（说明殿后）时按 `midSystemCacheBreakpoint`：`automatic`（缺省）→ 顶层 `cache_control`（宿主已给则不动）、`previous-user` → 最后一条 user 末块、`drop` → 不打。每一步都查 `budget()`：块级 + 顶层不超过 4。
6. 落点最后 `orderLandings` 排回输入顺序。

### 3.4 `encodeResponsesRequest`：IR → Responses 请求体（F3）

1. **角色**：`systemRole = responses.systemRole ?? (reasoning ? "developer" : "system")`；`systemPrompt` 是 `input` 首项，`system_note` 在它出现的位置直接放出（Responses 对 developer / system 的位置没有规则，不用归位）；宿主声明 `midConversationSystem: false` 才框成 `<system_note>` user 文本记 lossy(user-role)。
2. **user 侧**：user → `{ role: "user", content: [input_text | input_image] }`（空内容 dropped；不收图换占位记 lossy）；compaction → `[Summary of earlier conversation]` user 文本（lossy user-text）；tool_result → `{ type: "function_call_output", call_id, output }`，只有文本时 `output` 是字符串、`isError` 加 `[tool error]\n` 前缀（lossy），带图片且模型收图时是 `input_text` + `input_image` 数组。
3. **assistant**：一轮拆成多个项。text → `{ type: "message", role: "assistant", id, status: "completed", content: [output_text] }`，id 取 `replay.textSignature`（裸 msg_ id 或 pi 版 `{"v":1,"id","phase"}` JSON），别家或没有就补 `msg_reins_<n>`（空正文 dropped）；thinking → `reasoningItemOf(replay)` 解出带非空 `encrypted_content` 的整项就原样 push（同家别的型号照发并备注），别家 / 无加密项 dropped 并说明原因；tool_call → `{ type: "function_call", id?, call_id: toolCallId, name, arguments: JSON 字符串 }`，`id` 只在 `replay.itemId` 存在且同一模型时带。
4. **请求体**：宿主 `requestOptions` 先铺（`input` / `tools` / `previous_response_id` 剥掉），`model` / `input` / `stream: true` / `store: false` 后盖；`tools[]` 是 `{ type: "function", name, description, parameters, strict: false }`；`reasoning && encryptedReasoning !== false` 时 `include` 合并进 `reasoning.encrypted_content`（去重）。`reasoning` / `max_output_tokens` 不缺省设置。
5. 落点最后 `orderLandings` 排回输入顺序。

### 3.5 `stream`：请求 → 草稿

1. `headersFor`：`auth` 缺省按协议（Chat / Responses bearer、Anthropic x-api-key），`"none"` 时不问 `apiKey` 回调；Anthropic 线固定 `anthropic-version: 2023-06-01`，`anthropic.betas` 非空才带 `anthropic-beta`（逗号拼接）；模型级 `headers` 最后盖。缺 key 抛 `LoweringError("missing_api_key")`。
2. `requestSignals`：宿主 signal 与 `AbortSignal.timeout(timeoutMs)` 合成；宿主中止优先。
3. `postJson`：非 2xx 读完正文抛 `HttpError`（core 的 `isTransientFailure` 先看 `status`，再看 `x-should-retry`）。网络错误由 fetch 原样上抛。
4. Chat：`consumeChatStream` 按 chunk 拼块，`[DONE]` 收尾；`stopReason` 有 tool_call 即 `toolUse`、`length` → length、`content_filter` / `insufficient_system_resource` / `aborted` → error、缺 finish → error（可重试）。
5. Anthropic：`consumeAnthropicStream` 按 `data.type` 分派，块按 `index` 存 Map；`signature_delta` 拼进 thinking 块、`input_json_delta` 拼进 tool_use 的 JSON（收尾解析，解析不了原样存字符串）；`message_delta` 记 `stop_reason` / `stop_details` / 输出用量；`error` 事件立即收尾记 error（`overloaded_error: Overloaded` 文案让 core 判可重试）。`stopReason`：有 tool_use 即 `toolUse`；`end_turn` / `stop_sequence` / `pause_turn` → stop；`max_tokens` / `model_context_window_exceeded` → length；`refusal` → error 带 category / explanation（不可重试）；没等到 `message_stop` → error "stream ended before message_stop"（可重试）。
6. Responses：`consumeResponsesStream` 按 `type` 分派，项按 `output_index` 存槽（reasoning / message / function_call / other）；`reasoning_summary_text.delta` / `reasoning_text.delta` 拼摘要（第二段起 `reasoning_summary_part.added` 补空行）、`output_text.delta` / `refusal.delta` 拼正文、`function_call_arguments.delta` 拼入参（`.done` 以整串为准）；`output_item.done` 以厂商最终形状定项（reasoning 整项存下、message 取 id / phase / content、function_call 取 id / call_id / arguments）；`response.completed` / `incomplete` 记 status / incomplete_details / usage 并用 `output` 回填加密项；`response.failed` / `error` 事件立即收尾记 error（`"<code>: <message>"`）。草稿：reasoning 有加密项就 `replay.thinkingSignature = JSON.stringify(item)`（摘要为空也出草稿；既无加密项又无摘要不出），message → `replay.textSignature = id`（+ `phase`），function_call → `toolCallId = call_id`、`replay.itemId = id`。`stopReason`：有 function_call 即 `toolUse`；`completed` → stop；`incomplete + max_output_tokens` → length、`incomplete + content_filter` → error（不重试）、`cancelled` / `failed` → error；没等到终态事件 → error "stream ended before response.completed"（可重试）。
7. 读流中途出错：先交出已拼的草稿，再按 `signal.aborted` → `aborted`、`timedOut()` → error（timed out）、其它 → error。
8. 用量：Chat `input = prompt_tokens − cached_tokens`、`cacheRead = cached_tokens`；Anthropic `input = input_tokens`（本就不含缓存）、`cacheRead = cache_read_input_tokens`、`cacheWrite = cache_creation_input_tokens`；Responses `input = input_tokens − cached_tokens − cache_write_tokens`、两者分别落 `cacheRead` / `cacheWrite`；`costOf` 按模型价目算 `costUsd`。

## 4 核心设计决策

**共用层只产 IR，不产协议消息** — pi 版的中间层是 pi-ai 的三角色 `Message[]`，协议细节漏到第二跳靠 `onPayload` 改写。这里 IR 只记事实，三条协议各自从 IR 编码，没有第二跳。边界：IR 的 `dropped` item 顺序无意义，只用于记落点。

**`payload.body` 就是线上请求体** — 排查 400 直接看它；也让 lazy-tools 的 provider 原生路径成为可能。边界：URL 与鉴权头不在 payload 里。

**Chat 方言只收 DeepSeek 的 `reasoning_content`，且写侧"字段必在"**（DECISIONS 2026-09-14 F1 定形）— DeepSeek 带 `tools` 的请求里每条历史 assistant 都必须带该字段。

**Anthropic 的中途 system 在 encoder 里归位，退路是 user 文本而不是丢**（DECISIONS 2026-09-15 F2 定形 ①）— 厂商规则：不能首条、须紧跟 user、后接 assistant 或收尾；pi 版的 `placeOf` 是同一算法。位置比时间线晚一条 user 的仍算 exact 并备注，因为说明只换位置不改对话顺序（用户消息后移才记 lossy）。

**Anthropic 的 thinking 只回放带签名的，无签名 dropped 而非降成正文**（F2 定形 ③）— 私下推理不该变成模型"说过的话"；Fable 5.1 缺省 display omitted 时正文为空、签名在，所以判据是签名不是正文（流侧空正文带签名也出草稿）。`redacted_thinking` 的 data 存 `replay.thinkingSignature` + `redacted: true`，与 pi 版同字段，两条路线的事件可互换。

**Anthropic 的缓存断点由本包打三处，说明殿后缺省顶层 `cache_control`**（F2 定形 ④）— B1 实测 `automatic` 与不注入持平、`previous-user` 低 3～6 点、留在 system 上几乎零命中；F2 spike 在官方上实证第二个请求起 cacheRead > 0。边界：块级 + 顶层封顶 4，宿主顶层 `cache_control` 不覆盖。

**`anthropic-beta` 用到才带，`thinking` 不缺省设置，`max_tokens` 缺省取模型声明**（F2 定形 ⑤）— F0 实测中途 system 不需要 beta 且某些 beta 抬高拒答率；Opus 5 起厂商缺省 adaptive、Fable 5.1 对 `type:"disabled"` 400、Haiku 4.5 仍要 `budget_tokens`，代次差异由宿主的 `requestOptions` 定。

**宿主 `requestOptions` 里的 `system` / `tools` 剥掉**（DECISIONS 2026-09-15）— 这两个字段只由事件与工具表决定；之前"有才后盖"让宿主传的一份漏进请求体，F2 单测抓到，Chat 线同修。

**内置模型表是最小表，宿主可覆盖任何字段** — 价目是 2026-09-14 / 15 查阅的公开价，DeepSeek 存峰值价，`costUsd` 是估算上限。

**错误文案对齐官方 SDK 格式，不另造重试约定** — `HttpError` 的 `message` 是 `"<status> <body>"`；超时 `TimeoutError` 文案含 timeout、core 判可重试；宿主中止 `AbortError` 不重试。

**落点按输入顺序排回** — core 的 `LoweredRequest.landings` 承诺"顺序与输入一致"，encoder 记完再 `orderLandings`。

**Responses 线 `store: false` 强制、`previous_response_id` 剥掉**（DECISIONS 2026-09-15 F3 定形 ①）— 时间线是唯一真源，每个请求把历史全量放进 `input`，OpenAI 侧的会话状态不是我们依赖的东西；也让三条线的请求形状一致。

**Responses 线 reasoning 的回放判据是 `encrypted_content`，推理模型缺省永远带 include**（F3 定形 ②）— pi 版只在请求带 effort 时才带 include、`thinkingReplay` 随 requestOptions 变，但 gpt-5 缺省就开推理，不带 include 就会产出无法回放的 reasoning 项。整项 JSON 存 `replay.thinkingSignature`（summary 拆分与 id 都要原样回去；与 pi 版互换），写侧整项原样放回；没有加密项 / 别家的 dropped 不降正文（F0 R3b：伪造加密项 400，回放的必须是原件）。`responses.encryptedReasoning: false` 关掉，`thinkingReplay` 如实报 false。

**Responses 线两个 id 分开存**（F3 定形 ④）— `toolCallId = call_id`（core 各处用的短 id：pending 配对、asTool 子会话 id），`fc_` 项 id 在 `replay.itemId` 且只在同一模型回放时带回（OpenAI 校验 fc 项与 rs 项的配对，pi-ai 同一取向）；正文项 id 在 `replay.textSignature`（裸 msg_ id，pi 版 JSON 也认），没有就补 `msg_reins_<n>`（pi-ai 也这么补，厂商接受）。

**内置表同 id 两协议各一份，OpenAI 官方 id 无协议解析缺省 Responses** — `findBuiltin(provider, id, api?)` 带协议精确取（工厂总是带），F1 时只有 Chat 条目、当时缺省是 Chat；Responses 是 OpenAI 的主协议、推理系列只有它，所以缺省改成它，Chat 用 `openaiChat()` 或自己声明。边界：测试目标模型要显式取条目。

**有损如实进矩阵** — Chat 四处（thinking dropped、merged-text、tool-text-only / `[tool error]` 前缀、无断点）；Anthropic 与 pi 版逐格对照只差三格（无签名 thinking dropped 而非 text-or-drop、redacted 单列、tool_result 图片按能力处置）；Responses 与 pi 版只差三格（无加密项 dropped 而非 text-or-drop、非对象入参 exact 而非 wrapped-args——`arguments` 本就是 JSON 字符串、tool_result 多一格 lossy 表达 isError 前缀 / 图片）。宁可声明有损，不静默丢。

**`auth: "none"`** — CF 网关这类自带凭证头的上游不该被 `missing_api_key` 挡住，也不该被塞 `Authorization: Bearer`（F0 实测带了会失败）。

**与 pi 版并存、新宿主推荐本包、总包不带任何降级层**（DECISIONS 2026-09-15「F4 收口」）— 推荐的依据是数据：协议超集、矩阵更严（无签名 / 无加密项 dropped 而非降正文）、真模型三线全通、最严档 workerd 15/15、零依赖、`payload.body` 即线上体。不删 pi 版：已发布宿主在用、pi-ai 上游替我们跟模型表与新特性、两包 `replay` 同形随时可换。`examples/` 暂留 pi 版，等 AdRate 真实接入时切换并复跑 eval 门禁。
