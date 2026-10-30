# forced-compact — 到阈值强制模型整理的上游核实

对应 OPT-261030-3（OnSet 反馈建议 4）。裸 HTTP 打 DeepSeek 官方 Chat Completions（`deepseek-v4-flash`，缺省 thinking 模式），前缀约 7.6k token、一段做到一半的巡检对话、最后一条是工具结果。

运行：`node spikes/forced-compact/probe.mjs [轮数]`（DeepSeek）；`node spikes/forced-compact/probe-anthropic.mjs [轮数]`（经 CF 网关打官方 Anthropic，缺省 `claude-haiku-5-5`）。配置自动从信息文件读；两个探针共用 `scenario.mjs` 的同一段对话。

## 结果（2026-10-30，6 轮）

| 臂 | 做法 | 照做 | 缓存命中率 |
| --- | --- | --- | --- |
| W2 基线 | 前缀原样 | — | 97.0% |
| A 追加说明 | 工具表不变、不强制，末尾一条 system 说明"先 compact 再继续" | 6/6，入参全合法、无夹带调用 | 98.0% |
| B 强制指定 | `tool_choice: {function: compact}` | 0/6，**400 `Thinking mode does not support this tool_choice`** | — |
| Br 强制任一 | `tool_choice: "required"` | 0/6，同一个 400 | — |
| C 只留 compact | 同一条说明，工具表只剩 compact | 6/6 | **1.7%**（只剩 128 token 命中） |

## Anthropic 官方对照（2026-10-30，claude-haiku-5-5 经 CF 网关，thinking 缺省 adaptive，3 轮）

前缀约 10.7k token，顶层 `cache_control` 自动断点；说明是末尾一条中途 `role:"system"`。

| 臂 | 照做 | 缓存命中率 |
| --- | --- | --- |
| W2 基线 | — | 100% |
| A 追加说明 | 3/3，入参全合法 | 99.3% |
| B `tool_choice: {type:"tool", name:"compact"}` | 3/3 被接受，但**缓存全失**（与文档"改 tool_choice 让 messages 缓存失效"一致）；1/3 同批夹带 9 个 `get_ad_group`；摘要明显更短（1.7k～2k 字对 A 的 4k～5k） | 0% |
| Br `tool_choice: {type:"any"}` | 0/3，都去调业务工具 | 99.9% |
| C 只留 compact | 3/3 | 0% |

花费：三轮合计不到 0.1 美元（Haiku 5.5 输入 0.10 / 输出 0.50 美元每百万 token）。

## 连续两条中途 system（同日补，1 轮）

感知说明与整理请求同轮各追加一条时，末尾是两条连续的 system（lowering-fetch Anthropic 线 `flushNotes` 每条说明各成一条 system 消息）。A2 臂按这个形状发：

| 上游 | 结果 | 缓存命中率 |
| --- | --- | --- |
| Haiku 5.5（CF 网关，官方） | 200，先调 compact，入参合法 | 98.9% |
| DeepSeek v4 flash（Chat） | 200，先调 compact，入参合法 | 97.5% |

收口 OPT-260915-2（"Anthropic 线连续两条中途 system 未实证"）：官方接受，不用合并。

## 请求走 user、感知仍走 system（2026-10-31，OPT-261031-1，Haiku 5.5 经 CF 网关，3 轮）

`ARMS=W2,U node spikes/forced-compact/probe-anthropic.mjs 3`。U 臂是整理请求标 `directive` 后 lowering-fetch Anthropic 线的实际形状：请求以 `<system_note>` 文本并进末条 user（tool_result 之后），同轮感知说明仍是其后的中途 system。

| 臂 | 照做 | 缓存命中率 |
| --- | --- | --- |
| W2 基线 | — | 100% |
| U 请求走 user + 感知 system | 3/3，入参合法（摘要 3k～3.9k 字） | 98.8% |

## 结论

- DeepSeek thinking 模式拒绝一切强制 tool_choice；Anthropic 新一代 Fable 5.1 / Opus 5.5 / Sonnet 5.5 文档写明强制 400，Haiku 5.5 接受但缓存全失、还会夹带别的调用——"加 tool_choice 通道"这条路不值得走。
- 换工具表 = 整段缓存作废：两家都把工具定义排在前缀最前面（DeepSeek 只剩 128 token 命中，Anthropic 归零）。
- 前缀不动、末尾追加一条指令式说明：两家缓存照命中（98% / 99.3%），模型 DeepSeek 6/6、Haiku 5.5 3/3 先整理。注意这里的说明是明确命令（"Before doing anything else, call compact now"），与 onset-pause 里无效的那种"建议在收尾前整理"不是一回事。
- 一次强制整理的代价约是输出 2.5k～8k token（含 thinking），输入几乎全走缓存。
