# OnSet 样本：run 进行中到的新消息（建议 13）

对应 `../2026-10-30-OnSet反馈-compact与perception改进建议.md` 建议 13。用途是在真模型上复现：制片的 run 跑到一半，Boss 通过了定稿并附了指示，看它拿到消息后会不会转向。

## 场景

- 项目「国内经营类漫剧验证」，角色是制片（沈一舟，role id `producer`），会话 `01a1ac61-b93c-7ec8-893a-f2799324d2b3`。
- 选的这次 run：00:17:56 开始，00:37:21 结束（2026-11-06 本地时间，UTC+8），起止 seq 80–154。
- run 期间来了两条投递：
  - 00:19:10 Boss 通过方案定稿并附言（`signoff_approved`）。
  - 00:28:50 Boss 私信说团队记忆建重复了（`boss_dm`）。
- 两条投递都要等到下一次 run（00:37:21）才交给模型，见 seq 156–157。

## 文件

| 文件 | 内容 |
|---|---|
| `session-log.jsonl` | 会话日志 seq 1–157，从 OnSet 库里 `reins_events` 原样导出，一行一个事件。seq 1–79 是这次 run 之前的历史，会话里没有发生过 compaction，所以这就是模型当时看到的完整上下文。seq 80–154 是这次 run。seq 155–157 是下一次 run 的开头 |
| `system-prompt.md` | 当时的系统提示，即 OnSet 的 `systemPromptOf(producer, 项目)`。不含 reins 各 Socket 自己加的部分（记忆规则、compact 规则等），那些见 `socket-texts.json` |
| `onset-tools.json` | OnSet 这边的 31 个工具：name、description、inputSchema（JSON Schema）。包括 `batch`、`fork`、`end_run` |
| `socket-texts.json` | OnSet 传给 reins Socket 的中文文案：`MEMORY_RULES_ZH`（memory 的 rules）、`COMPACT_RULES_ZH`（compact 的 rules）、`MEMORY_DIRECTORIES`。制片没有装 skills |
| `deliveries.json` | 两条投递的原文，包括发送方、原因、时间和频道 |

工具表里有 35 个名字，见 seq 79 的 `core.tools_bound`。其中 31 个在 `onset-tools.json` 里，另外 `compact`、`memory`、`recall`、`fetch_blob` 这 4 个由 reins 的 Socket 自带，用 reins 现版缺省定义即可。

## 当时的装配

- **模型**：`gemini-3.8-flash-high`，经公司中转站走 Anthropic Messages 线。窗口 400000，最大输出 64000，思考开、档位没设，图片和视频都开。
- **reins 版本**：core 0.9.0、brain 0.8.2、lowering-fetch 0.6.0、store-sqlite 0.3.6、server 0.4.3。
- **Socket 顺序**：
  1. `legacyGuard`：OnSet 自己的遗留调用拦截。
  2. `haltOnFailure()`
  3. `memoryGuard`：OnSet 自己的记忆写入守门。
  4. `memory({ rules: MEMORY_RULES_ZH, directories: MEMORY_DIRECTORIES })`
  5. `pins`：两个常驻快照，`role-memory` 和 `reference-index`，`tool: false`。日志里 seq 4 和 seq 88 就是它们当时的内容。
  6. `stopAfter({ tools: ["end_run"] })`
  7. `compact({ rules: COMPACT_RULES_ZH, force: 中文请求文案 })`
  8. `spill()`
  9. `perception({ limits: { contextTokens: 400000 }, render: 中文版 })`
  10. `budget({ limits: { contextTokens: 400000 } })`
- **run 输入**：两条草稿。先是一条 `system_note(host)`，`meta.onsetRunBriefing: true`，内容是背景；后面是一条 `user_message`，内容是新消息。见 seq 80–81、156–157。

## 改成中途送达后，消息应该在哪一刻塞进去

工具执行都是毫秒级，时间都花在模型上，两次工具调用之间相隔 1 到 3 分钟。

| 投递 | 到达 | 当时正在进行的模型调用 | 下一个空档 | 塞进去的位置 |
|---|---|---|---|---|
| Boss 定稿 | 00:19:10 | 00:18:02 发起，00:20:24 回来（seq 85 `chat_send`） | 00:20:24 | seq 88（pin）之后、产出 seq 89 的那次调用之前 |
| Boss 私信 | 00:28:50 | 00:28:23 发起，00:28:59 回来（seq 111 `board_update`） | 00:28:59 | seq 113 之后、产出 seq 114 的那次调用之前 |

按现在的做法，模型从 seq 89 到 154 一直不知道 Boss 已定稿、附了什么话：它写了记忆、发布了文档、建了条目、派了 7 次活。

**要塞的内容可以直接用 seq 156–157。** 157 的 `user_message` 就是 OnSet 中途送达时会组装出的格式。156 的背景是 00:37 算的，但里面列的变化（方案更新到 v2、林晚 00:19:54 写的经验库条目）在 00:20:24 都已经发生，所以和中途送达那一刻算出来的基本一致。复现第一个空档时，可以只塞定稿那一条：把 157 里私信那一段去掉，标题改成"共 1 条"。

**判据**：塞进去之后，模型接下来的动作是否按定稿和附言调整。比如通知美术、把生图模型口径写进计划，或者不再按"方案待确认"来安排工作。还是照旧继续它手上的事。

## 脱敏

日志、投递和工具表里没有 Key、中转站地址、本机路径或个人联系方式，模型配置里也只给了型号。角色名和剧本内容是虚构的，Boss 附言是原话。`res://` 引用的资源正文不在样本里，模型当时读到的内容在工具结果里，已经包含在日志中。
