# gateway-check — 聚合网关三协议核实（2026-09-08）

> 网关：`https://aireiter.com/api/v1`，密钥在仓库根 `模型API测试信息.md`（已 gitignore，不进提交）。
> 运行：`node spikes/gateway-check/probe.mjs <messages|chat|responses>`；`MODEL=gpt-5.5` 可指定 GPT 模型。
> 原始响应落在 `out/`（已 gitignore）。

## 结论一句话

三种协议在**我们依赖的特性上都是标准的**：流式事件形状、工具调用、用量字段、thinking / reasoning 回放、中途 system / developer 消息，与官方 API 行为一致。reins 的降级层不改一行代码就能通过网关跑通两家真实往返。两处非标准之处见下。

## 模型路由

- 网关**按模型严格分协议**：Claude 只能走 `/messages`，GPT 只能走 `/chat/completions` 与 `/responses`；Claude 走 chat 会 400 `Model is not compatible with the requested API protocol`。
- 模型表 37 个：Claude 4.6 ~ 5 全系（含 `-kiro` 变体），GPT 只有 `gpt-5.4`、`gpt-5.5`、`gpt-5.6-sol/terra`、`gpt-6-astra`；**没有 GPT-5 之前的模型**（`gpt-4o` 不存在）。
- 测试当日 `gpt-5.4` 持续 502/503（上游不可用），其余 GPT 正常；`gpt-6-astra` 走 chat 时连接被重置一次。
- 网关会**规范化模型名**：`claude-opus-5[1M]` 也能请求成功，响应里 model 为 `claude-opus-5`。

## Anthropic Messages（claude-sonnet-4-5 / claude-opus-5）10/12

| 项 | 结果 |
| --- | --- |
| 流式 SSE，事件 `message_start / content_block_* / ping / message_delta / message_stop` | 标准 |
| thinking 块 + `signature_delta`，`message_delta.usage.output_tokens_details.thinking_tokens` | 标准 |
| tool_use + `input_json_delta` 可拼 JSON，`stop_reason=tool_use` | 标准 |
| `message_start.usage` 含 input / cache_creation / cache_read | 标准 |
| 第二轮回放签名 thinking + tool_result | 接受，正常作答 |
| 中途 `role:"system"`：Opus 5 接受；Sonnet 4.5 返回官方原文 400 `role 'system' is not supported on…` | 与官方一致 |
| **伪造 thinking 签名**（Sonnet 4.5 与 Opus 5，开 thinking） | **200 接受** —— 官方会 400。说明网关在转发前**丢弃或不校验历史 thinking 块**。对 reins 无害（回放不会报错），但意味着经此网关 thinking 回放实际上可能不生效 |
| Claude 经 chat/completions | 400，网关不做协议转换 |

## OpenAI Chat Completions（gpt-5.5）7/7

流式 `chat.completion.chunk`、`delta.tool_calls` 分片、`finish_reason=tool_calls`、`stream_options.include_usage` 末尾 usage（含 `reasoning_tokens`）、tool 角色回传后作答，全部标准。
备注：chat 响应的 `id` 形如 `resp_…`，说明网关内部用 Responses 上游**模拟** chat 协议；形状标准，但别指望 chat 独有的字段（如 `logprobs`）。

## OpenAI Responses（gpt-5.5）9/10

| 项 | 结果 |
| --- | --- |
| 事件 `response.created / in_progress / output_item.added / done / function_call_arguments.delta / done / response.completed` | 标准 |
| reasoning item 带 `encrypted_content`（`include: ["reasoning.encrypted_content"]`，`store:false`） | 标准，1420 字符 |
| function_call 带 `call_id` / `id`（fc_）/ `arguments` | 标准 |
| `response.completed.usage` 含 `reasoning_tokens`；另多出一个非官方 `attribution` 字段（按 item 拆分用量） | 多字段不影响解析 |
| 第二轮回放 reasoning(encrypted) + function_call/output + 中途 developer 消息 | 接受，且遵守了 developer 指令（回答以「播报：」开头） |
| **伪造 encrypted_content** | **200 接受** —— 官方会 400。同 Anthropic 一侧：网关不校验 / 可能丢弃历史 reasoning |
| 字符串 `input` 非流式 | 标准 |

## 用 reins 降级层实跑（`spikes/t7-live-roundtrip/live.mjs`）

```
pnpm build && K=<key> REINS_GATEWAY_BASE=https://aireiter.com/api ANTHROPIC_API_KEY=$K OPENAI_API_KEY=$K REINS_OPENAI_MODEL=gpt-5.5 node spikes/t7-live-roundtrip/live.mjs
```

两家各两轮全部跑通：第一轮模型思考并调 `get_weather`，第二轮回放上一轮 thinking / reasoning、回传工具结果、注入中途 system_note 后作答。Anthropic 第二轮所有落点 exact（system_note 真的以中途 system 送达）；OpenAI 第二轮 system_note 落 developer，exact。

## 对 reins 的影响

1. 网关可以作为 dogfood 与 eval 的模型来源，两家协议都能用；`gpt-5.4` 不稳时换 `gpt-5.5`。
2. thinking / reasoning 回放在网关上"不报错但可能不生效"，eval 若要测回放质量须直连官方 API 对照。
3. 本次顺带修了降级层一处判定：响应报告的模型 id 与请求 id 不同（日期后缀、别名、网关改名）时不再算"别家模型"，只比 provider 与 api。
