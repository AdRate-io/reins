# examples/mcp —— 一个 agent 同时挂进程内工具与 MCP 工具

任务 P1 的验收示例。三个文件各管一件事：

- `server.ts`：一台库存 MCP 服务器（Streamable HTTP，`node:http` 搬运给官方 `createMcpHandler`）。三个工具刻意带不同注解——`list_inventory`（readOnlyHint）、`get_item`（无注解）、`restock`（destructiveHint）——看 reins 怎么把注解翻成风险与审批缺省。服务器完全不知道 reins 的存在。
- `agent.ts`：`buildAgent()` **每次请求调一次**，MCP 配置从 `mcp.config.json` 现读。进程内工具 `today` 与 MCP 工具排在同一张表上；全部脑子模块装上，approval 放末尾。MCP Socket 按服务器配置的 JSON 缓存：配置没变复用连接，变了才换并关旧的。
- `run.ts`：起服务器（同进程）→ 跑任务 → 暂停等审批就逐条问 y/n（`--approve-all` 全批）→ 续跑到底 → 时间线写成 JSONL。

```bash
pnpm build
REINS_PROVIDER=deepseek node examples/mcp/run.ts "把库存低于补货线（reorderAt）的商品全部补到 20 件。先查今天日期，做完给我一张变更表。" --approve-all
# 单独起服务器：node examples/mcp/server.ts；再用 --no-server 跑
```

## 免重启是怎么成立的

没有热加载接口，也不需要：`createAgent()` 只是拼对象，工具表在每次 run 起步解析静态贡献时才定。改 `mcp.config.json`（加一台服务器、换前缀、删一台），**下一次请求**就用新表；循环会 append 一条 `tools_bound` 快照，和上一条比对有增删就再 append 一条模型可见的说明（"Your available tools changed… Added: … Removed: …"）。

已知约束：暂停等审批的 run 是按暂停时的工具表签名的，续跑前配置变了会被判配置漂移（`config_mismatch`）拒绝。三选一：等会话跑完再改配置、接受该次 paused 作废重起 run、或 `allowConfigDrift: true` 放行（同样会出工具变化说明）。库不会静默用另一张表续跑审批人看过的调用。

## 第一条真实任务（2026-09-10，DeepSeek deepseek-v4-flash，`recordings/restock-below-threshold.jsonl`）

| 指标 | 值 |
| --- | --- |
| 事件 / run 次数 / 模型轮 / 工具调用 | 51 / 3（两次审批暂停）/ 5 / 9 |
| 工具调用构成 | `today`（进程内）1、`list_inventory` 1、`pin` 1、`restock` 3、`get_item` 3 |
| 审批 | `restock` ×3 走工具自己的 `needsApproval`（destructiveHint → 缺省 true）；`get_item` ×3 走 approval 模块 byRisk（无注解 → medium → 问人） |
| 结果 | A-101 3→20、B-200 0→20、C-300 4→20，写后逐个 `get_item` 回读核对，最后给出带日期的变更表 |
| 缓存 | 四次请求 cacheRead 2176 / 2304 / 2304 / 3328，工具表逐 run 稳定 |

看到的模型行为：先 `today` + `list_inventory` 并行；把待补清单 pin 住；三条 `restock` 一批发出等审批；写完主动回读；汇报只列变更。

第一次真跑抓到两个问题，都已修：进程内 `today` 没声明 `risk`，approval 缺省把"未声明"当要问人（示例给它 `risk: "low"`）；示例服务器用单个 `WebStandardStreamableHTTPServerTransport`，第二次请求连接时 400 "Server already initialized"——一个实例只服务一个会话，改用 `createMcpHandler` 按请求建实例（见 `docs/踩坑记录.md`）。
