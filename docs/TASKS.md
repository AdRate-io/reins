# reins 任务板

> 活文档，只留**未完成**的任务与待 Boss 事项。开工顺序 = 从上往下第一个未勾选。
> 任务完成：打勾 + 一行结论（日期、关键结论、用例数）；实现细节写进 `docs/模块盘点/` 对应文件，踩到的坑写 `docs/踩坑记录.md`，决策写 `docs/DECISIONS.md`——**不要把实现记录堆进任务行**。
> 一个里程碑收口后，把已完成任务整段迁到 `docs/归档/<日期>-任务记录-<里程碑>.md`，本板始终短。
> 已完成记录：M0 / M1 / M2 见 `docs/归档/2026-09-10-任务记录-M0-M2.md`；0.1 发前清单与发布见 `docs/归档/2026-09-14-任务记录-0.1发布.md`。

## 状态一句话

**0.1 已发布（2026-09-14，当前 0.1.1）**：11 个包在 npm 官方源 `@reinsjs/*`（总包 `@reinsjs/agent`；0.1.1 是只改文档的同号补丁，把 tarball 里的旧总包名改掉），源码在 GitHub `AdRate-io/reins`（Release v0.1.0），MIT，版权 NewRate Limited。788 个用例全绿。公开类型已冻结：改公开行为要走 changeset，破坏性变更升 minor。0.2 候选 D1～D5 全部完成（lazyTools、handler `onEvent`、approval `ttlMs`、跨进程 run 登记、脱敏配方，未发布），四个包各有 minor changeset 待 `changeset version`；0.2 等 AdRate 升 Node 22 后跑第一轮真实接入、把问题一起打进去再发（0.1.x 补丁并行）。**当前主线：lowering-fetch**（下一步 F1；F0 等 Boss 建好 CF 网关）。

## 0.2 候选（2026-09-14 AdRate 接入评估提出，按顺序；全是加法，不改已发布形状；细节见 DECISIONS 同日"AdRate 接入六条评估"）

- [x] **D1 工具懒发现**（2026-09-14）：brain 第十个模块 `lazyTools()`，菜单进系统提示、`tool_find` 取回、已取回集合从时间线重建、直接调隐藏工具即 block 指路；+16 用例，eval fixture `tool-discovery`（200 件）+4 用例，780 全绿。spike：Anthropic 上取回后首请求缓存整段重写，频繁换任务按价目加权贵 1.7 倍，一次取回约 7 请求回本——opt-in、README 写边界。eval 两族门禁通过（第二轮，完成度 100% 持平，总 token −59%～−62%）。第一轮 fixture authId 类型缺陷见踩坑记录
- [x] **D2 handler 旁路观测钩子**（2026-09-14）：`HandlerOptions.onEvent(event, { sessionId, principal, request })` + `warn` 出口；只 live 不 replay、先广播再调不挡 run、出错只告警一次、run 收尾等观测链（Workers waitUntil 覆盖）；不进 core。+4 用例，784 全绿。server README 加 Observability 节、根 README 写明 `agent.run()` 本身可 `for await`
- [x] **D3 审批过期**（2026-09-14）：`approval({ ttlMs })`，比 `approval_request.at` 与宿主批准事件 `at`（循环时钟，不读墙钟），过期在 ask 落点 deny + block、留 `approval_decision(by: "approval.expired")`，模型看到"可重新发起"；`by` 用策略 id 而非 `"reins"`（理由见 DECISIONS）。+4 用例，788 全绿
- [x] **D4 跨进程 run 登记**（2026-09-14）：core `RunLease` 接口 + `InMemoryRunLease` + `runLeaseConformance`；server `RunRegistry` 接口化（`InMemoryRunRegistry` 缺省、`create` 异步）、`leasedRunRegistry`（心跳 ttl/3、丢租约 abort → paused(host)、结束 release、失败只告警）、`ActiveRun.onFinish`；store-pg `reins_runs` + `PgRunLease` 三条单语句、过期用库时钟；`createAgent` 自动装。+25 用例（含 PGlite 跨包用例），813 全绿。实施时与设计的三处出入见 DECISIONS 同日「D4 实施定形」
- [x] **D5 脱敏配方入 README**（2026-09-14）：根 README 新节 "Redacting what reaches the log"——工具结果在 `afterTool` 草稿上脱敏（放 sockets 最前，spill 搬进 blob 的才是干净的），其余事件包一层 `append`；配方原文即 `packages/brain/src/redaction.recipe.test.ts`，+3 用例锁住两条边界（顺序放错 blob 漏原文；包装管日志与模型视图但管不到 yield 出去的对象，SSE / onEvent 仍见原文）。不加接口；`redactingLog` 助手仍等 AdRate 接入时再议
- 不做（记 DECISIONS）：规范化 JSON 序列化算 digest 以放开 jsonb——改的是状态格式，等真有"全库禁 json"硬约束再随版本一起升

## lowering-fetch（2026-09-14 与 Boss 讨论立项，见 DECISIONS 同日「lowering-fetch 立项」；按顺序做，每步一个会话）

- [ ] **F0 靶子体检**：`spikes/cf-gateway-fidelity`——对 CF AI Gateway 统一计费的 Anthropic 与 OpenAI 端点做暗号法忠实度体检（顶层 system、中途 system、tool_result 紧跟、`cache_control` 用量字段、thinking 签名往返、多轮工具调用的密钥注入），逐项核对产出内容不看状态码；结论进 `spikes/README.md`。**依赖 Boss 建好网关**（见"待 Boss"）；网关未就绪先做 F1
- [ ] **F1 骨架 + Chat Completions**：新包 `packages/lowering-fetch`（零 dependencies、零 `node:*`）；三线共用：`fetch` 封装（超时 / signal / 瞬断判据与 core 同策略）、SSE 解析、用量与成本、最小模型表 + `ModelRef` 覆盖；Chat 线 `toRequest` / `stream`：system → `system` 消息、脑子说明落点、工具调用与 `tool` 角色、图片、`reasoning_content` 读侧扩展（DeepSeek）；损失矩阵 Chat 列（thinking 不可回放、无显式缓存断点）；DeepSeek 直连真模型跑通一条带工具的多轮
- [ ] **F2 Anthropic Messages**：中途 system 摆放规则（S1）、tool_result 紧跟与用户消息后移 `lossy(user)`、四个缓存断点处置、thinking 签名回放、`anthropic-beta`；复用 lowering-pi 的损失矩阵用例逐格对照；经 CF 网关真模型验证（F0 通过为前提）
- [ ] **F3 OpenAI Responses**：reasoning 加密项回放、`previous_response_id` 不用（时间线是真源）、工具与图片；与 pi 版矩阵逐格对照；经 CF 网关验证
- [ ] **F4 收口**：`pnpm check:dist`、workerd 最严档实测（复跑 `spikes/edge-runtime-check` 加 fetch 版）、README（与 pi 版的选择指南）、盘点 / 全景图 / 技术方案 §11 追加、changeset；总包不带它（与 pi 版同规则）

## 0.1 之后（纯新增或有外部依赖）

- [ ] 四环境验证：Bun / Deno / Vercel Edge 未实测（edge-runtime-check 只测了 Cloudflare workerd）——验证不改接口
- [ ] tools-mcp 后续：官方 Anthropic 直连对"历史含已移除工具"的接受度未测（无 key；DeepSeek Anthropic 协议与 OpenAI Responses 已实测接受）；OAuth 流程、sampling / elicitation / resources / prompts 待真需求
- [ ] memory 挂载表（共享只读 + 私有可写，技术方案 §9.6）——等团队场景真出现"同时挂两块"再做
- [ ] lazy-tools 的 provider 原生路径（**排在 lowering-fetch F4 之后**，在 fetch 版里做，pi 版请求整形改不了）：Anthropic tool search / `defer_loading` 把取回的工具定义注入 messages 而不改 tools 块，避开取回后的缓存整段重写（D1 spike 实测 Claude 上频繁换任务贵 1.7 倍）——降级层优化，`lazyTools()` 接口不变；MCP 工具也想懒发现须先给 `SocketSetup` 加"此前已并入的工具"
- [ ] 运行时告警与构造期错误文案英文化（全包十几处字符串，含 memory / spill / budget / skills）——审查指出英文 README + 中文告警对非中文用户是死路；0.1 保持中文（DECISIONS 2026-09-13）

## 待 Boss 本人操作（不挡开发）

- [ ] **Cloudflare AI Gateway 验证靶子**（挡 F0 / F2 / F3 的真模型验证，不挡 F1）：AI Gateway 新建网关 → 打开 Authenticated Gateway 并生成网关令牌 → 充值 Unified Billing（20 美元级别够用，Anthropic / OpenAI 两个 provider 保持"使用 Cloudflare 凭证"、不填自己的 key）→ 把 account id、gateway id、网关令牌写进根目录 `模型API测试信息.md`（已 gitignore）

- [ ] npm 组织 `reinsjs` 目前只有 `adrate-io` 一个 owner；若要让别的账号也能发版，在 npmjs.com/org/reinsjs 邀请
