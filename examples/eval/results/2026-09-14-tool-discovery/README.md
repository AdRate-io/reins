# 2026-09-14 工具懒发现（D1）两族对照

fixture：`examples/eval/fixtures/tool-discovery`（200 件工具、6 个短任务）；臂 `eager`（200 件全给）vs `lazy`（装 `lazyTools()`）；每格 3 遍，单题一个新会话。

| 轮 | 模型 | 报告 | 结论 |
| --- | --- | --- | --- |
| r1 | DeepSeek v4 flash | `r1-deepseek-v4-flash-report.md` | 门禁过（98.3% = 98.3%）；**fixture 有缺陷**：假账户 authId 是字符串，schema 要整数 |
| r1 | Claude sonnet-5 | `r1-claude-sonnet-5-report.md` | 完成度 96.7% < 98.3% 差一格未过；掉分格两臂同题，全是模型按契约停下来问 authId（见踩坑记录 2026-09-14） |
| r2 | DeepSeek v4 flash | `r2-deepseek-v4-flash-report.md` | **通过**：完成度 100% = 100%，总 token 27.7k vs 73.2k（−62%），计费等价 4.7k vs 8.4k（−44%），零走错门 |
| r2 | Claude sonnet-5 | `r2-claude-sonnet-5-report.md` | **通过**：完成度 100% = 100%，总 token 40.2k vs 97.4k（−59%），计费等价 9.2k vs 10.5k（−13%），零走错门 |

lazy 每题多约一轮（先 `tool_find`）；缓存命中 eager 99% vs lazy 87%～94%（取回后那一请求重写）。缓存代价的完整账见 `spikes/d1-lazy-tools-cache/`。
