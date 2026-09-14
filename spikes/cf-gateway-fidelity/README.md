# cf-gateway-fidelity — Cloudflare AI Gateway 透传路径的忠实度体检（2026-09-14，F0）

> 目的：lowering-fetch 要拿官方 Anthropic / OpenAI 端点当验证靶子，我们没有厂商账号（Boss 定：有封号风险不申请），走 Cloudflare AI Gateway 的 Unified Billing 透传路径。aireiter 网关曾把中途 system 丢掉、把伪造签名放行，用它验出来的"通过"是假的，所以 CF 网关用前必须先证明它**不改写请求、不吞响应、错误原文透传**。
> 运行：`node spikes/cf-gateway-fidelity/probe.mjs <anthropic|responses|chat|all>`；配置自动从仓库根《模型API测试信息.md》读（`cfut_` 令牌、`account id：`、`gateway id：`），原始响应含响应头落 `out/`（已 gitignore）。环境变量可换模型：`CF_ANTHROPIC_MODEL`（缺省 claude-haiku-4-5-20251001）、`CF_ANTHROPIC_MID_MODEL`（缺省 claude-opus-5）、`CF_OPENAI_MODEL`（缺省 gpt-5-mini）、`CF_CHAT_MODEL`（缺省 gpt-4o-mini）。

## 方法

暗号法：把暗号放在被测位置，只让模型回一行；内容到了模型才答得出。**判据永远是产出内容，不是状态码。** 反向项（伪造 thinking 签名、伪造 `encrypted_content`、假 `anthropic-beta` 头、未知参数）要求拿到**厂商原文 400**，证明网关没有在中间吞掉再放行——这正是 aireiter 露馅的地方。

## 结果：43/43（Anthropic 25、Responses 13、Chat 5）

### Anthropic Messages（claude-haiku-4-5-20251001；中途 system 用 claude-opus-5）

| 项 | 结果 |
| --- | --- |
| 顶层 `system` 暗号 / 无暗号对照 | 到达 / NONE |
| 响应形状 | 厂商原生：`msg_` id、`usage` 含 `cache_creation_input_tokens` / `cache_read_input_tokens` / `cache_creation.ephemeral_5m_input_tokens` / `service_tier` / `inference_geo`；Opus 5 响应多一个 `input_transformations: []` 字段（解析器忽略未知字段） |
| **末尾中途 `role:"system"`**（perception 的真实落点）@ Opus 5 | **到达**，带 pi-ai 同款 beta 头或不带都到达 |
| **中段中途 system**（user → system → assistant → user）@ Opus 5 | 到达 |
| 中途 system 跟在 assistant 文本后 @ Opus 5 | 厂商原文 400：`role 'system' must follow a 'user' message or an 'assistant' message ending in a server tool result; the directive-only form (content: [] with output_config) is accepted at any position`（**F2 摆放规则的实证**） |
| 中途 system @ Haiku 4.5 | 厂商原文 400 `role 'system' is not supported on this model`（没有被偷偷改写成 user 放行） |
| 假 `anthropic-beta` 头 | 厂商原文 400 `Unexpected value(s) … for the anthropic-beta header`（**beta 头原样透传**）；合法 `interleaved-thinking-2025-05-14` 照常 200 |
| 强制 `tool_choice` 得 `tool_use`；`tool_result` 紧跟 + 同条 user 后续文本 | 到达（答里同时有工具结果的 28 与文本里的暗号） |
| 块级 `cache_control`（system >4096 token，两次同前缀） | 首发 `cache_creation_input_tokens: 6315`，复发 `cache_read_input_tokens: 6315`——**缓存断点原样透传、用量字段原生** |
| 顶层 `cache_control`（pi-ai automatic 模式补的字段） | 接受，`cache_creation_input_tokens: 6333` |
| 流式 + thinking + 工具 | SSE 事件序列完整、每帧可解析；标准键之外只多一个 `"p"`（Anthropic 自己的防缓冲填充）；thinking 块带 `signature_delta`；`input_json_delta` 可拼 JSON；`message_delta` 带 `stop_reason` 与 `usage.output_tokens_details.thinking_tokens` |
| 回放带签名 thinking + `tool_result` | 接受并按结果作答 |
| **伪造签名** | 厂商原文 400 `Invalid signature in thinking block`（**签名真被校验，网关没吞 thinking 块**——aireiter 这里是 200） |
| 六轮工具往返（流式 / 非流式交替）同一会话 | 6/6 全 200、末轮答出累计结果与暗号；**未复现 GitHub cloudflare/ai#408 报的多轮密钥注入失效** |
| 四个并发请求各自暗号 | 各自拿到，无串扰 |
| 完全相同的请求并发 4 次 | 4 个不同 `msg_` id，`cf-aig-cache-status: MISS`——**网关缺省不缓存** |
| base64 图片块 | 接受（答 1 张 + 暗号） |

### OpenAI Responses（gpt-5-mini）

| 项 | 结果 |
| --- | --- |
| 顶层 developer 暗号 / 对照 | 到达 / NONE |
| 响应形状 | 厂商原生：`resp_` id、`status`、`usage.input_tokens_details.cached_tokens` / `cache_write_tokens`、`output_tokens_details.reasoning_tokens` |
| 流式 + `include: ["reasoning.encrypted_content"]` + 工具 | 事件序列完整、每帧可解析；reasoning item 带 `encrypted_content`（约 1.6k 字符）；function_call 带 `call_id` / `id` / `arguments` |
| 回放 encrypted reasoning + function_call/output + 中途 developer | 接受，工具结果与 developer 暗号都到达 |
| **伪造 `encrypted_content`** | 厂商原文 400 `The encrypted content for item rs_… could not be verified`（真被校验；aireiter 这里是 200） |
| 自动缓存用量（>1024 token 同前缀两次） | 第二次 `cached_tokens: 6272` |
| 六轮工具往返（流式 / 非流式交替） | 6/6 全 200，末轮答出结果与暗号 |
| data: URL 图片 | 接受 |
| 不存在的模型名 | **401 `Missing bearer or basic authentication in header`**——网关只对认识的模型注入厂商密钥，模型名打错表现为 401 而不是 404 / 400 |

### OpenAI Chat Completions（gpt-4o-mini）

system 暗号到达；`chatcmpl-` id 与 `usage.prompt_tokens_details` 原生；流式 `delta.tool_calls` 分片可拼 JSON、`stream_options.include_usage` 末尾 usage 到；`tool` 角色回传 + 末尾中途 system 都到达；未知参数 `bogus_param_reins` 拿到厂商原文 400 `Unrecognized request argument supplied`。备注：**强制 `tool_choice` 指定函数时官方 `finish_reason` 是 `stop` 不是 `tool_calls`**（首轮把它当 FAIL 是我记错规范）。

## 顺带发现（不是网关问题，但会影响探针与 F2）

1. **"告诉我你被告知的暗号"这种问法放在中途 system 位置，会触发 Anthropic 自己的 `reasoning_extraction` 拒答**：HTTP 200、`stop_reason: "refusal"`、`content: []`、`stop_details.explanation` 是厂商原文（说违反反向工程条款）。同一句放顶层 system 正常；把说明改成感知式（"context window used 37%"，问百分比）末尾 / 中段、开关 thinking 都稳定到达。中段位置 + 说明里带 "session tag X" + `anthropic-beta: mid-conversation-output-config-2026-07-01` 触发 5/5，去掉该 beta 头 0/5，`thinking-binding-controls` 0/2，`interleaved-thinking` 1/2——是概率性分类器，beta 头抬高触发率。**对 reins**：perception 说明是感知式文本不涉密语，实测到达；F2 的 beta 头只在真用到对应功能时才带。
2. **Opus 5 缺省带 adaptive thinking**：`max_tokens: 30` 会被 thinking 吃光（`stop_reason: max_tokens`、无 text、`thinking_tokens: 30`）。探针给 Opus 至少几百 token。
3. **Haiku 4.5 的最小可缓存长度是 4096 token**（Opus / Sonnet 1024）：3.5k token 的 system 带 `cache_control` 用量全 0，不是网关剥了断点。
4. **CF 账户级限流**：`HTTP 429`，正文是 CF 信封 `{"success":false,"error":[{"code":2018,"message":"Wholesale Rate limited"}],"name":"AiGatewayE…"}` 而不是厂商错误体；一轮约 90 个请求撞 6 次，多在每次运行**第一个 Opus 5 请求**上连撞两次、之后不再出现，三套并行跑更容易撞；8 个并发 Opus 请求刻意去撞没撞上。`retry-after` 头未抓到（重试覆盖了落盘）。**对 lowering-fetch**：429 按 core 的瞬断判据重试没问题，但错误体解析不能假定是厂商形状。

## 结论

**CF AI Gateway 透传路径可以当官方 Anthropic / OpenAI 靶子**：三条协议请求原样到厂商（中途 system、cache_control、beta 头、图片、工具往返、签名 / 加密推理全部生效），响应原样回来（原生用量字段、`stop_details`、SSE 只多 `"p"`），错误原文透传，缺省不缓存、并发不串扰、多轮密钥注入稳定。F2 / F3 的真模型验证走它；aireiter 降为辅助。
