# relay-check — Boss 的 Claude 中转忠实度体检（2026-09-09，E3b 前置）

> 运行：`node spikes/relay-check/probe.mjs [claude-sonnet-5|claude-opus-5]`（密钥与地址从《模型API测试信息.md》"Claude中转"段读）。
> 方法同 `aireiter-gateway-check`：暗号法 + 工具往返 + 让模型逐条列出它看到的对话。

## 结论

1. **直通官方 Anthropic Messages API，不改内容**。用量里有 `cache_creation.ephemeral_5m_input_tokens`、`service_tier`、`inference_geo` 等官方字段；
   模型逐条列对话时没有多出任何前置消息（aireiter 会塞 非我们所写的身份提示与 Human/Assistant 对）。
2. **中途 `role:system` 的官方规则**（400 原文）："role 'system' must follow a 'user' message or an 'assistant' message ending in a server tool result"。
   即 system 可以出现在对话中段，但**前一条必须是 user**。reins 降级层的归位规则（system_note 挪到该 user 之后、下一条 assistant 之前）正好合规；
   探针里放在 assistant 之后的两个用例被拒是探针形状的问题。opus-5 在合规位置（末尾、紧跟 user）答出暗号。
3. **中转强制开 thinking 且隐藏思考内容**：响应里 `thinking` 块正文为空、只有签名，`output_tokens_details.thinking_tokens` 计入输出。
   `max_tokens` 给小了（60 / 300）opus 会把额度全用来想、`stop_reason=max_tokens` 无正文 —— 探针里的"200 但正文为空"全是这个原因，不是丢内容。
   reins 请求的输出上限 16k，实跑（`examples/eval/out/smoke-relay`，sonnet-5，只读 fixture）4 轮完成、6/6 事实答对。
4. **缓存**：官方 `cache_creation_input_tokens` / `cache_read_input_tokens` 正常回报（第一请求 796 写入），`input_tokens` 只计未缓存部分。
5. **sonnet-5 的性格**：问题**之后**追加的说明（同一条 user 的尾部、或紧随其后的另一条 user）它多答 NONE，opus-5 与 DeepSeek 答暗号。
   不是中转丢内容（同一位置 opus 能答），是 sonnet 更倾向把"事后追加"的话当背景而非指令。感知说明在 reins 里落在 user 之后、以 system 角色进入，不是这个形状。
6. 传输是 **http 明文到一个 IP**，密钥裸奔，只作测试用。

| 用例 | sonnet-5 | opus-5 |
| --- | --- | --- |
| B 末尾中途 system（紧跟 user） | 200（额度耗尽无正文） | **PINEAPPLE** |
| A 中途 system 紧跟 assistant | 400 官方规则 | 400 官方规则 |
| U1 末尾 user 角色说明 | NONE | 额度耗尽 / 纯文本版 **PINEAPPLE** |
| U2 中段 user 角色说明 | 200（额度耗尽） | **PINEAPPLE** |
| M 并入最后一条 user 正文（问题之后） | NONE | 额度耗尽 |
| T 顶层 system | **PINEAPPLE** | **PINEAPPLE** |
| N 无说明 | NONE | NONE |
| 工具往返 + thinking 回放 | 200，thinking 有签名 | 200（opus 未返回 thinking 块） |
| 并行两条 tool_result 后接 system（紧跟 user） | 400（前一条是 user 却被拒？—— 前一条 user 只含 tool_result；规则括号里的"server tool result"指官方服务端工具，本地工具结果后不能直接接 system） | 同左 |

> 第 9 行：探针里把 system 直接排在只含 tool_result 的 user 之后被拒。但 **reins 实跑没有撞上**（E3b brain-lean 臂 9 格、每轮都有感知说明、0 次 400）——
> 降级层的归位规则把标记的 system 说明挪到下一条 user 之后、assistant 之前，避开了这个形状。结论：官方 API 上 `midConversationSystem: true` 可用。
