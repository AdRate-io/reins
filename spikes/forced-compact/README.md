# forced-compact — 到阈值强制模型整理的上游核实

对应 OPT-261030-3（OnSet 反馈建议 4）。裸 HTTP 打 DeepSeek 官方 Chat Completions（`deepseek-v4-flash`，缺省 thinking 模式），前缀约 7.6k token、一段做到一半的巡检对话、最后一条是工具结果。

运行：`node spikes/forced-compact/probe.mjs [轮数]`，密钥自动从信息文件读。

## 结果（2026-10-30，6 轮）

| 臂 | 做法 | 照做 | 缓存命中率 |
| --- | --- | --- | --- |
| W2 基线 | 前缀原样 | — | 97.0% |
| A 追加说明 | 工具表不变、不强制，末尾一条 system 说明"先 compact 再继续" | 6/6，入参全合法、无夹带调用 | 98.0% |
| B 强制指定 | `tool_choice: {function: compact}` | 0/6，**400 `Thinking mode does not support this tool_choice`** | — |
| Br 强制任一 | `tool_choice: "required"` | 0/6，同一个 400 | — |
| C 只留 compact | 同一条说明，工具表只剩 compact | 6/6 | **1.7%**（只剩 128 token 命中） |

## 结论

- DeepSeek thinking 模式拒绝一切强制 tool_choice，与 Anthropic 开 thinking 时只允许 `auto` / `none` 同类——"加 tool_choice 通道"这条路在两家主力形态下都走不通。
- 换工具表 = 整段缓存作废：DeepSeek 把工具定义排在前缀最前面，收窄工具表后只剩 128 token 命中。
- 前缀不动、末尾追加一条指令式说明：缓存照命中，模型 6/6 先整理。注意这里的说明是明确命令（"Before doing anything else, call compact now"），与 onset-pause 里无效的那种"建议在收尾前整理"不是一回事。
- 一次强制整理的代价约是输出 2.5k～8k token（含 thinking），输入几乎全走缓存。
