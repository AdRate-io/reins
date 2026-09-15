# 2026-09-15 —— 0.2 发前复跑门禁：五个示例与 eval 切到 `@reinsjs/lowering-fetch`

> 目的：示例与 eval 脚本从 pi 版降级层换到 fetch 版之后，PRD §7 门槛 2（巡检降本）与 D1 门禁（工具发现）在两个模型族上是否仍成立。
> 配置：窗口 64k；巡检 3 fixture × 2 臂（threshold 基线 / brain-lean 候选）；工具发现 6 题 × 2 臂（eager / lazy）。
> 降级层：DeepSeek 走 fetch 版官方 Chat Completions 直连（`deepseek()`，reasoning_content 方言）；Claude 走 fetch 版 Anthropic Messages 线，
> 官方 Sonnet 5 经 Cloudflare AI Gateway 透传（15 格）与 Boss 的 Claude 中转（resume 的 brain-lean 3 格，中转密钥中途额度用完、重置后补）。
> thinking 不手设，用厂商缺省（Sonnet 5 adaptive、DeepSeek 缺省 thinking 模式）；0.1 时是 pi 版 + DeepSeek Anthropic 端口 + thinking 预算 2048。

## 结论一览

| 套件 | 模型 | 基线 | 候选 | 总 token（基线 → 候选） | 完成度 | 召回 | 门禁 | 报告 |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
| 巡检降本（3 × 2 × 6 遍） | DeepSeek v4 flash（Chat 线） | threshold | brain-lean | 203,645 → 226,529（+11%） | 100% → 99.6% | 99% → 100% | ❌ token、完成度两条未过 | `patrol-deepseek-chat-report.md` |
| 巡检降本（3 × 2 × 3 遍） | Claude Sonnet 5（Messages 线） | threshold | brain-lean | 209,519 → 204,427 | 100% → 100% | 100% → 100% | ✅ 四条全过 | `patrol-claude-sonnet-5-report.md` |
| 工具发现（6 × 2 × 3 遍） | DeepSeek v4 flash | eager | lazy | 73,059 → 29,486 | 100% → 100% | — | ✅ | `discovery-deepseek-chat-report.md` |
| 工具发现（6 × 2 × 3 遍） | Claude Sonnet 5 | eager | lazy | 99,431 → 36,387 | 100% → 100% | — | ✅ | `discovery-claude-sonnet-5-report.md` |

工具发现两族与 2026-09-14 的结论一致（lazy 上下文小一半以上、零走错门）。Sonnet 5 巡检四条全过。**DeepSeek 巡检 token 一条未过**，完成度差的是 audit 第 6 遍一格 93%（汇报表少列一项），其余 35 格 100%。

## DeepSeek 的 token 差是谁的：三组对照（都只跑 disable 这个 fixture，差全在它上）

| 代码 | 降级层 / 端口 / thinking | 遍 | threshold | brain-lean | 轮数（基线 / 候选） | 报告 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 0.2（本次） | fetch 版 Chat 线 / 官方 / 缺省 | 6 | 254,689 | 338,371 | 8.0 / 10.0 | `patrol-deepseek-chat-report.md` 的 disable 行 |
| 0.2 | fetch 版 Anthropic 线 / DeepSeek Anthropic 端口 / 2048 | 3 | 278,778 | 354,929 | 8.3 / 10.3 | `control-…-anthropic-fetch-report.md` |
| 0.2 | **pi 版**（0.1 原样）/ 同上 / 2048 | 6 | 252,219 | 355,889 | 8.0 / 10.3 | `control-…-anthropic-pi-report.md` |
| 0.2 英文化之前（14345eb^） | pi 版 / 同上 / 2048 | 6 | 273,023 | 270,316 | 8.3 / 9.7 | `control-…-pre-i18n-code-report.md` |
| **v0.1.1 原代码** | pi 版 / 同上 / 2048 | 6 | 281,249 | 302,826 | 8.7 / 10.0 | `control-…-v0.1.1-code-report.md` |
| 2026-09-09（e3c，同 fixture） | pi 版 / 同上 / 2048 | 3 | ≈191k | ≈200k | 6.7 / 6.3 | `../2026-09-09-deepseek-v4-flash/e3c-deepseek-v4-flash-report.md` |

读法：

1. **不是 fetch 版的问题**。同一天、同一配置只换降级层实现（第 2 行 vs 第 3 行），数字同一个形状；pi 版自己今天也是候选贵四成。
2. **轮数变的是模型，不是代码**。9 月 9 日 DeepSeek 跑这条任务 brain-lean 只要 6.3 轮，今天四个版本的代码（v0.1.1、英文化前、0.2 两种降级层）都要 9.7～10.3 轮，
   基线 threshold 都是 8～8.7 轮。录像结构（审批 14 条、暂停 2～3 次、工具 33～40 次、说明 7～10 条、pin 7～13 条）各版一致——多出来的轮是模型把同一批写操作拆成了更多次调用。
3. **英文化的影响未排除，但 n=6 分不出**。英文化前的 0.2 代码那组持平（每轮上下文约 2.8 万），英文化后的三组每轮约 3.5 万、总量贵三到四成，v0.1.1 贵 8%。
   可是 brain-lean 单格 20 万～43 万、同配置不同批次的 6 遍均值就能差三成，这个量级的差用 6 遍下不了结论；threshold 臂各批次稳定在 25 万～28 万。
   要查就查两点：英文化后模型可见的工具结果确认句（pin / spill / memory）在 DeepSeek 分词下长了多少；每轮上下文 2.8 万 → 3.5 万是哪些事件撑大的。
4. **基线自己的噪声就很大**：threshold 单格 22 万～37 万、7～11 轮，3 遍的均值能差出两成，门禁按 3 遍判会翻硬币。今后 DeepSeek 上判 token 项至少 6 遍，最好 12。

所以 0.2 照发，门禁结论如实记：Sonnet 5 全过；DeepSeek 上 brain-lean 的 token 项今天不过——与换降级层无关（同日同配置只换实现，数字同形），轮数变化是模型自己的，
每轮上下文的差是否来自英文化留作待办。都不是降标准的理由，也不是卡发布的理由：这套门禁在 DeepSeek 上的裕度从 0.1 起就只有 7%。

## 顺带抓到的 bug

resume fixture 的种子历史是 2026-09-08 用 DeepSeek 录的，thinking 事件带签名；fetch 版两条线（Anthropic / Responses）当时只按"同厂商 + 同协议"回放，
签名喂给 Sonnet 5 厂商 400 `Invalid signature in thinking block`，六格 0 秒 error。已改为 provider + api + model 三者一致才回放、换型号 dropped 并进有损矩阵；
案卷见 `docs/踩坑记录.md` 2026-09-15。这 6 格用修复后的 dist 重跑通过。

## 花费

Claude Sonnet 5 经 Cloudflare AI Gateway（厂商原价 +5%）：巡检 18 格（含限流与签名 bug 导致的重跑）+ 工具发现 36 格，约 20 美元；DeepSeek 全部对照约 1 美元。
教训：第一次估"几美元"太乐观，跑 Claude 长任务前先按上次报告的计费等价乘格数报数。
