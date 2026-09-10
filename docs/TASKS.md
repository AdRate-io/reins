# reins 任务板

> 活文档，只留**未完成**的任务与待 Boss 事项。开工顺序 = 从上往下第一个未勾选。
> 任务完成：打勾 + 一行结论（日期、关键结论、用例数）；实现细节写进 `docs/模块盘点/` 对应文件，踩到的坑写 `docs/踩坑记录.md`，决策写 `docs/DECISIONS.md`——**不要把实现记录堆进任务行**。
> 一个里程碑收口后，把已完成任务整段迁到 `docs/归档/<日期>-任务记录-<里程碑>.md`，本板始终短。
> 已完成的 M0（骨架）/ M1（脑子 v1）/ M2（数字）全部记录见 `docs/归档/2026-09-10-任务记录-M0-M2.md`。

## 状态一句话

M0、M1、M2 主体已完成（2026-09-08 ～ 09-10）：11 个包、约 3.2 万行 TS、682 个用例全绿；PRD §7 门槛 2 两族达成，compact 改为推荐默认；P1 MCP 包已落地。0.1 发布前只剩发布本身（E4）。

## 0.1 发布前（按顺序）

- 2026-09-10 Boss 设想"多角色 agent 团队"（各角色自己的系统提示 / 工具 / 记忆，会话在数据库）后追加，设计见技术方案 §9.6 隔离设计、§10 MCP、§10.1 子代理即工具；已讨论并记录决策，未实施：
  - [x] **P1 `@reins/tools-mcp`** —— 2026-09-10 完成：新包 20 用例 + core `tools_bound` 与静态贡献异步化，665 用例全绿；官方 client 2.0.0 主入口零 `node:*`，最严档 workerd list + call 通过；`examples/mcp` 用 DeepSeek 跑通真实任务（进程内 + MCP 工具同表，同会话 3 次 run、9 次工具调用、写后回读，录像 `recordings/restock-below-threshold.jsonl`）；两条协议对历史含已移除工具均接受，平台不需要不对称规则。细节：`模块盘点/tools-mcp.md`、DECISIONS 2026-09-10 四行、踩坑记录"一个 MCP HTTP 服务端传输只服务一个会话"
  - [x] **P2 memory 隔离收口** —— 2026-09-10 完成：`memoryTable` / `table` 选项只换记忆表名（事件表与 blob 表按 session_id 隔离不可配），表名白名单防注入且不合规不碰库，两包 +4 用例、669 用例全绿，dist 产物冒烟通过；README 新增 "Memory and how to isolate it"（三层 + 三段示例）。挂载表仍不做。细节：`模块盘点/store.md`、DECISIONS 2026-09-10 "P2" 行
  - [x] **P3 子代理手写范式** —— 2026-09-10 完成：`examples/team/` 编排者 + 分析师（linked）+ 文案（detached）共用一套 pg（PGlite）存储、记忆按 namespace 分角色再分用户；`subagent-tool.ts` 逐条标号五件事，5 个脚本化用例（674 用例全绿）；DeepSeek 一次跑通真实任务（父 24 事件 / 两子 31 + 14），`replay.ts` 只凭父录像找到两子并核对用量一致、退出码 0。不改 core。细节：示例 README、技术方案 §10.1、DECISIONS 2026-09-10 "P3" 行
  - 0.2（发布后，已写进 §16 M3）：`asTool(agent, opts)` 助手 —— 审批冒泡（`Interruption.kind="subagent"`，子状态随父状态序列化）与预算合算；memory 挂载表按需
- [x] **R9 trust 标注落地** —— 2026-09-10 完成：core `lowering/trust.ts` 一份纯函数（`<untrusted source="tool:<name>">…</untrusted>`，只包文本，`</untrusted` 转义记 lossy），lowering-pi 与 TanStack 适配器共用，缺省开、`trustMarkers: false` 可关；用例断言线协议请求体含标记且事件 payload 不变，682 用例全绿；DeepSeek 复跑 examples/team 行为不受影响。细节：技术方案 §14、DECISIONS 2026-09-10 "R9" 行、模块盘点 core / lowering-pi / adapter
- [ ] E4 文档、CHANGELOG、0.1 发布准备（远程仓库与 npm 组织在此之前建，见"待 Boss"）—— 含每个包的 README（对外，英文）、CHANGELOG 首条、changeset、`pnpm build` 产物 import 自检、根 README 状态从 Pre-alpha 改 0.1

## 0.1 之后

- [ ] tools-mcp 后续（0.1 后）：官方 Anthropic 直连对"历史含已移除工具"的接受度未测（无 key；DeepSeek Anthropic 协议与 OpenAI Responses 已实测接受）；OAuth 流程、sampling / elicitation / resources / prompts 待真需求
- [ ] R3（0.1 后）`loop/retry.ts` 瞬断正则偏宽：`timeout` / `409` 等在整段消息上匹配，含这些字样的 4xx 参数错也会被重试
- [ ] R4（0.1 后）`projection/types.ts` 注释"emitted 冲突则重跑投影"与 runLoop 不符（实际直接抛 StoreError）：改注释或真做重跑
- [ ] R5（0.1 后）TanStack 适配器导入客户端消息无幂等键，网络重试重发同一条 user 消息会入日志两次
- [ ] R7（0.1 后，2026-09-10 盘点发现）`adapter-tanstack-ai/src/interrupt.ts` 头注释承诺"init 时检查审批中断是否登记、未登记则 defer 降级为拒绝"，`middleware.ts` 里没有这个运行时检查，只有类型层保护；`middleware.ts` 的 `warn` 注释列的"缺 BlobStore / 未登记中断"两种告警也不存在。实现该检查（fail-closed）或改注释
- [ ] R8（0.1 后，2026-09-10 盘点发现）`store-pg/src/pg.test.ts` 有用例标题写"jsonb 往返"，该包刻意用 `json` 不用 `jsonb`（键序会被重排、configHash 对不上），改标题
- [ ] `asTool(agent, opts)` 助手（0.2，技术方案 §10.1）：审批冒泡（`Interruption.kind="subagent"`，子状态随父状态序列化）与预算合算
- [ ] memory 挂载表（共享只读 + 私有可写，技术方案 §9.6）——等团队场景真出现"同时挂两块"再做
- [ ] `@reins/lowering-fetch` 零依赖降级层（装机 65 M 的 pi-ai 之外的可选项）
- [ ] 四环境验证：Bun / Deno / Vercel Edge 未实测（edge-runtime-check 只测了 Cloudflare workerd）

## 待 Boss 本人操作

- [ ] 发布前：在 GitHub 创建组织 `reins` 并授权推送（或授权我用现有账号创建并转移）
- [ ] 发布前：在 npm 创建组织 `reins`
- [ ] 发布前：源录像 `examples/adrate/recordings/patrol-disable.jsonl` 仍含真实广告主 id / 人名且已在 git 历史里，须换成脱敏版（`examples/eval/fixtures/adrate-patrol/recording.jsonl` 已是脱敏版）或改写历史，定一个
