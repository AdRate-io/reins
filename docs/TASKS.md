# reins 任务板

> 活文档，只留**未完成**的任务与待 Boss 事项。开工顺序 = 从上往下第一个未勾选。
> 任务完成：打勾 + 一行结论（日期、关键结论、用例数）；实现细节写进 `docs/模块盘点/` 对应文件，踩到的坑写 `docs/踩坑记录.md`，决策写 `docs/DECISIONS.md`——**不要把实现记录堆进任务行**。
> 一个里程碑收口后，把已完成任务整段迁到 `docs/归档/<日期>-任务记录-<里程碑>.md`，本板始终短。
> 已完成记录：M0 / M1 / M2 见 `docs/归档/2026-09-10-任务记录-M0-M2.md`；0.1 发前清单与发布见 `docs/归档/2026-09-14-任务记录-0.1发布.md`。lowering-fetch F0～F4 见 `docs/归档/2026-09-15-任务记录-lowering-fetch.md`。

## 状态一句话

**0.1 已发布（2026-09-14，当前 0.1.1）**：11 个包在 npm 官方源 `@reinsjs/*`（总包 `@reinsjs/agent`；0.1.1 是只改文档的同号补丁，把 tarball 里的旧总包名改掉），源码在 GitHub `AdRate-io/reins`（Release v0.1.0），MIT，版权 NewRate Limited。788 个用例全绿。公开类型已冻结：改公开行为要走 changeset，破坏性变更升 minor。0.2 候选 D1～D5 全部完成（lazyTools、handler `onEvent`、approval `ttlMs`、跨进程 run 登记、脱敏配方，未发布），四个包各有 minor changeset 待 `changeset version`；0.2 等 AdRate 升 Node 22 后跑第一轮真实接入、把问题一起打进去再发（0.1.x 补丁并行）。**lowering-fetch F0～F4 全部完成（2026-09-15）**：三条线真模型各臂全通、最严档 workerd 实测 15/15、changeset 已备，随下次 `changeset version` 与 0.2 一起发；新宿主推荐 fetch 版，pi 版并存。**L1 lazy-tools 原生路径完成（2026-09-15）**：fetch 版 Anthropic 线取回工具不再打掉缓存前缀（spike 取回后第 2 请求 cache_read Haiku 8497 / Opus 4062，老路子 0），core / brain / lowering-fetch / lowering-pi / adapter / ui-agui 各有 changeset 待 `changeset version`。1218 个用例全绿。

## 0.2 候选（2026-09-14 AdRate 接入评估提出，按顺序；全是加法，不改已发布形状；细节见 DECISIONS 同日"AdRate 接入六条评估"）

- [x] **D1 工具懒发现**（2026-09-14）：brain 第十个模块 `lazyTools()`，菜单进系统提示、`tool_find` 取回、已取回集合从时间线重建、直接调隐藏工具即 block 指路；+16 用例，eval fixture `tool-discovery`（200 件）+4 用例，780 全绿。spike：Anthropic 上取回后首请求缓存整段重写，频繁换任务按价目加权贵 1.7 倍，一次取回约 7 请求回本——opt-in、README 写边界。eval 两族门禁通过（第二轮，完成度 100% 持平，总 token −59%～−62%）。第一轮 fixture authId 类型缺陷见踩坑记录
- [x] **D2 handler 旁路观测钩子**（2026-09-14）：`HandlerOptions.onEvent(event, { sessionId, principal, request })` + `warn` 出口；只 live 不 replay、先广播再调不挡 run、出错只告警一次、run 收尾等观测链（Workers waitUntil 覆盖）；不进 core。+4 用例，784 全绿。server README 加 Observability 节、根 README 写明 `agent.run()` 本身可 `for await`
- [x] **D3 审批过期**（2026-09-14）：`approval({ ttlMs })`，比 `approval_request.at` 与宿主批准事件 `at`（循环时钟，不读墙钟），过期在 ask 落点 deny + block、留 `approval_decision(by: "approval.expired")`，模型看到"可重新发起"；`by` 用策略 id 而非 `"reins"`（理由见 DECISIONS）。+4 用例，788 全绿
- [x] **D4 跨进程 run 登记**（2026-09-14）：core `RunLease` 接口 + `InMemoryRunLease` + `runLeaseConformance`；server `RunRegistry` 接口化（`InMemoryRunRegistry` 缺省、`create` 异步）、`leasedRunRegistry`（心跳 ttl/3、丢租约 abort → paused(host)、结束 release、失败只告警）、`ActiveRun.onFinish`；store-pg `reins_runs` + `PgRunLease` 三条单语句、过期用库时钟；`createAgent` 自动装。+25 用例（含 PGlite 跨包用例），813 全绿。实施时与设计的三处出入见 DECISIONS 同日「D4 实施定形」
- [x] **D5 脱敏配方入 README**（2026-09-14）：根 README 新节 "Redacting what reaches the log"——工具结果在 `afterTool` 草稿上脱敏（放 sockets 最前，spill 搬进 blob 的才是干净的），其余事件包一层 `append`；配方原文即 `packages/brain/src/redaction.recipe.test.ts`，+3 用例锁住两条边界（顺序放错 blob 漏原文；包装管日志与模型视图但管不到 yield 出去的对象，SSE / onEvent 仍见原文）。不加接口；`redactingLog` 助手仍等 AdRate 接入时再议
- 不做（记 DECISIONS）：规范化 JSON 序列化算 digest 以放开 jsonb——改的是状态格式，等真有"全库禁 json"硬约束再随版本一起升

## 0.1 之后（纯新增或有外部依赖）

- [ ] 四环境验证：Bun / Deno / Vercel Edge 未实测（edge-runtime-check 只测了 Cloudflare workerd）——验证不改接口
- [ ] tools-mcp 后续：OAuth 流程、sampling / elicitation / resources / prompts 待真需求（"历史含已移除工具"官方 Anthropic 已于 2026-09-15 经 CF 网关补测接受，见 `spikes/l1-deferred-tools/` P8）
- [ ] memory 挂载表（共享只读 + 私有可写，技术方案 §9.6）——等团队场景真出现"同时挂两块"再做
- [x] **L1 lazy-tools 的 provider 原生路径**（2026-09-15）：core `ContentPart` 加 `tool_reference` 段（带定义快照）、`ToolSpec.deferLoading` / `LoweringCapabilities.deferredTools` / `BeforeModelPatch.deferredTools`；lazy-tools 按能力位分原生 / 过滤两路；fetch 版 Anthropic 线 `defer_loading` + `tool_reference` 块（GA 无 beta 头，Haiku 4.5 起），厂商规矩落进 encoder；其余线与 pi 版展开成文本、不发 deferLoading 的工具。spike：取回后第 2 请求 cache_read Haiku 8497 / Opus 4062，老路子归零；端到端 Haiku / Opus 各 9/9；取回之前被延迟的定义不进计费前缀（P9 六臂 6/6，删件臂整段命中带标臂）。`lazyTools()` 接口不变。+33 用例，1218 全绿；MCP 工具懒发现仍待 `SocketSetup` 加"此前已并入的工具"
- [ ] 运行时告警与构造期错误文案英文化（全包十几处字符串，含 memory / spill / budget / skills）——审查指出英文 README + 中文告警对非中文用户是死路；0.1 保持中文（DECISIONS 2026-09-13）

## 待 Boss 本人操作（不挡开发）

- [x] **Cloudflare AI Gateway 验证靶子**（2026-09-14 Boss 已建，网关 `reins-dev`；轻测 Anthropic Messages / OpenAI Responses / OpenAI Chat 三条透传端点非流式均原样回暗号、Anthropic 流式透传；配置与路径写法在 `模型API测试信息.md` 末尾。REST `/ai/v1/*` 路径不适用——它要账户级 API token，透传路径才是我们要的）

- [ ] npm 组织 `reinsjs` 目前只有 `adrate-io` 一个 owner；若要让别的账号也能发版，在 npmjs.com/org/reinsjs 邀请
