# reins 任务板

> 活文档，只留**未完成**的任务与待 Boss 事项。开工顺序 = 从上往下第一个未勾选。
> 任务完成：打勾 + 一行结论（日期、关键结论、用例数）；实现细节写进 `docs/模块盘点/` 对应文件，踩到的坑写 `docs/踩坑记录.md`，决策写 `docs/DECISIONS.md`——**不要把实现记录堆进任务行**。
> 一个里程碑收口后，把已完成任务整段迁到 `docs/归档/<日期>-任务记录-<里程碑>.md`，本板始终短。
> 已完成的 M0（骨架）/ M1（脑子 v1）/ M2（数字）全部记录见 `docs/归档/2026-09-10-任务记录-M0-M2.md`。

## 状态一句话

M0、M1、M2 主体已完成（2026-09-08 ～ 09-10）：11 个包、约 3.2 万行 TS、682 个用例全绿；PRD §7 门槛 2 两族达成，compact 推荐默认；P1 MCP、P2 记忆隔离、P3 子代理范式、R9 trust 标注全部落地。**2026-09-10 Boss 定：先清完"发前清单"再一起发 0.1**（筛选规则见 DECISIONS 同日"发包 = 冻结公开接口"）。发前清单已封口，不再往里加。

## 0.1 发前清单（按顺序，已封口 2026-09-10）

筛选规则：会改公开类型或默认行为的、规划清晰且无外部依赖的，发前做；纯新增的发后做。

- [ ] **R5** TanStack 适配器导入客户端消息无幂等键：网络重试重发同一条 user 消息会入日志两次。方向：按内容 + 位置生成稳定键，导入前查日志末尾去重；`模块盘点/adapter-tanstack-ai.md` 有入口流程
- [ ] **R7** `adapter-tanstack-ai/src/interrupt.ts` 头注释承诺"init 时检查审批中断是否登记、未登记则 defer 降级为拒绝"，`middleware.ts` 里没有这个运行时检查，只有类型层保护；`middleware.ts` 的 `warn` 注释列的"缺 BlobStore / 未登记中断"两种告警也不存在。实现该检查（fail-closed）或改注释——安全默认值，倾向实现
- [ ] **R3** `loop/retry.ts` 瞬断正则偏宽：`timeout` / `409` 等在整段消息上匹配，含这些字样的 4xx 参数错也会被重试。方向：先看状态码 / 错误类别，正则只兜没有结构化信息的错误
- [ ] **R4** `projection/types.ts` 注释"emitted 冲突则重跑投影"与 runLoop 不符（实际直接抛 StoreError）：改注释或真做重跑，二选一记 DECISIONS
- [ ] **R8** `store-pg/src/pg.test.ts` 有用例标题写"jsonb 往返"，该包刻意用 `json` 不用 `jsonb`，改标题
- [ ] **`asTool(agent, opts)` 助手**（技术方案 §10.1，原 0.2 提前到发前：要给 `Interruption` 加 `kind: "subagent"`、暂停携带子会话 sessionId 与子 `SerializedRunState`，属公开类型，发后再改是破坏性变更）：审批冒泡——子 paused(approval) 时父不结束工具而是整体 paused，宿主批完续跑父 run、父续跑先续跑子再拿结果，状态全部可序列化换进程成立；预算合算——子 run 的 token 计入父 `ctx.budget`。`examples/team/subagent-tool.ts` 的手写范式改为调用它（保留一份手写版对照）。先在对话里把 `Interruption` / `RunResult` 的形状说清并记 DECISIONS 再动手
- [ ] **E4** 文档、CHANGELOG、0.1 发布准备（远程仓库与 npm 组织在此之前建，见"待 Boss"）—— 含每个包的 README（对外，英文）、CHANGELOG 首条、changeset、`pnpm build` 产物 import 自检、根 README 状态从 Pre-alpha 改 0.1；最后 `pnpm publish`

## 0.1 之后（纯新增或有外部依赖）

- [ ] `@reins/lowering-fetch` 零依赖降级层（装机 65 M 的 pi-ai 之外的可选项）——新包，不动已有接口
- [ ] 四环境验证：Bun / Deno / Vercel Edge 未实测（edge-runtime-check 只测了 Cloudflare workerd）——验证不改接口
- [ ] tools-mcp 后续：官方 Anthropic 直连对"历史含已移除工具"的接受度未测（无 key；DeepSeek Anthropic 协议与 OpenAI Responses 已实测接受）；OAuth 流程、sampling / elicitation / resources / prompts 待真需求
- [ ] memory 挂载表（共享只读 + 私有可写，技术方案 §9.6）——等团队场景真出现"同时挂两块"再做

## 待 Boss 本人操作（不挡开发，挡发布）

- [ ] 发布前：在 GitHub 创建组织 `reins` 并授权推送（或授权我用现有账号创建并转移）
- [ ] 发布前：在 npm 创建组织 `reins`
- [ ] 发布前：源录像 `examples/adrate/recordings/patrol-disable.jsonl` 仍含真实广告主 id / 人名且已在 git 历史里，须换成脱敏版（`examples/eval/fixtures/adrate-patrol/recording.jsonl` 已是脱敏版）或改写历史，定一个

## 已完成（2026-09-10，待里程碑收口时迁归档）

- [x] **P1 `@reins/tools-mcp`** —— 新包 20 用例 + core `tools_bound` 与静态贡献异步化；官方 client 2.0.0 主入口零 `node:*`，最严档 workerd list + call 通过；`examples/mcp` 用 DeepSeek 跑通真实任务（录像 `recordings/restock-below-threshold.jsonl`）；两条协议对历史含已移除工具均接受。细节：`模块盘点/tools-mcp.md`、DECISIONS 2026-09-10 四行、踩坑记录"一个 MCP HTTP 服务端传输只服务一个会话"
- [x] **P2 memory 隔离收口** —— `memoryTable` / `table` 选项只换记忆表名，表名白名单防注入且不合规不碰库，两包 +4 用例，dist 冒烟通过；README 新增 "Memory and how to isolate it"。细节：`模块盘点/store.md`、DECISIONS "P2" 行
- [x] **P3 子代理手写范式** —— `examples/team/` 编排者 + 分析师（linked）+ 文案（detached）共用 pg（PGlite）存储、记忆按 namespace 分角色再分用户；`subagent-tool.ts` 逐条标号五件事，5 个脚本化用例；DeepSeek 两次跑通真实任务，`replay.ts` 只凭父录像找到子会话并核对用量一致。不改 core。细节：示例 README、技术方案 §10.1、DECISIONS "P3" 行
- [x] **R9 trust 标注落地** —— core `lowering/trust.ts` 一份纯函数（`<untrusted source="tool:<name>">…</untrusted>`，只包文本，`</untrusted` 转义记 lossy），lowering-pi 与 TanStack 适配器共用，缺省开、`trustMarkers: false` 可关；线协议请求体含标记且事件 payload 不变；DeepSeek 复跑 examples/team 行为不受影响。细节：技术方案 §14、DECISIONS "R9" 行、模块盘点 core / lowering-pi / adapter
