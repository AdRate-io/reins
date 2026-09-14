# reins 任务板

> 活文档，只留**未完成**的任务与待 Boss 事项。开工顺序 = 从上往下第一个未勾选。
> 任务完成：打勾 + 一行结论（日期、关键结论、用例数）；实现细节写进 `docs/模块盘点/` 对应文件，踩到的坑写 `docs/踩坑记录.md`，决策写 `docs/DECISIONS.md`——**不要把实现记录堆进任务行**。
> 一个里程碑收口后，把已完成任务整段迁到 `docs/归档/<日期>-任务记录-<里程碑>.md`，本板始终短。
> 已完成记录：M0 / M1 / M2 见 `docs/归档/2026-09-10-任务记录-M0-M2.md`；0.1 发前清单与发布见 `docs/归档/2026-09-14-任务记录-0.1发布.md`。

## 状态一句话

**0.1 已发布（2026-09-14，当前 0.1.1）**：11 个包在 npm 官方源 `@reinsjs/*`（总包 `@reinsjs/agent`；0.1.1 是只改文档的同号补丁，把 tarball 里的旧总包名改掉），源码在 GitHub `AdRate-io/reins`（Release v0.1.0），MIT，版权 NewRate Limited。788 个用例全绿。公开类型已冻结：改公开行为要走 changeset，破坏性变更升 minor。0.2 候选 D1～D5 全部完成（lazyTools、handler `onEvent`、approval `ttlMs`、跨进程 run 登记、脱敏配方，未发布），四个包各有 minor changeset 待 `changeset version`；0.2 等 AdRate 升 Node 22 后跑第一轮真实接入、把问题一起打进去再发（0.1.x 补丁并行）。**当前主线：lowering-fetch**（F0 靶子体检、F1 Chat 线已过，DeepSeek 直连与 CF 网关真模型各 8/8；下一步 F2 Anthropic Messages）。936 个用例全绿。

## 0.2 候选（2026-09-14 AdRate 接入评估提出，按顺序；全是加法，不改已发布形状；细节见 DECISIONS 同日"AdRate 接入六条评估"）

- [x] **D1 工具懒发现**（2026-09-14）：brain 第十个模块 `lazyTools()`，菜单进系统提示、`tool_find` 取回、已取回集合从时间线重建、直接调隐藏工具即 block 指路；+16 用例，eval fixture `tool-discovery`（200 件）+4 用例，780 全绿。spike：Anthropic 上取回后首请求缓存整段重写，频繁换任务按价目加权贵 1.7 倍，一次取回约 7 请求回本——opt-in、README 写边界。eval 两族门禁通过（第二轮，完成度 100% 持平，总 token −59%～−62%）。第一轮 fixture authId 类型缺陷见踩坑记录
- [x] **D2 handler 旁路观测钩子**（2026-09-14）：`HandlerOptions.onEvent(event, { sessionId, principal, request })` + `warn` 出口；只 live 不 replay、先广播再调不挡 run、出错只告警一次、run 收尾等观测链（Workers waitUntil 覆盖）；不进 core。+4 用例，784 全绿。server README 加 Observability 节、根 README 写明 `agent.run()` 本身可 `for await`
- [x] **D3 审批过期**（2026-09-14）：`approval({ ttlMs })`，比 `approval_request.at` 与宿主批准事件 `at`（循环时钟，不读墙钟），过期在 ask 落点 deny + block、留 `approval_decision(by: "approval.expired")`，模型看到"可重新发起"；`by` 用策略 id 而非 `"reins"`（理由见 DECISIONS）。+4 用例，788 全绿
- [x] **D4 跨进程 run 登记**（2026-09-14）：core `RunLease` 接口 + `InMemoryRunLease` + `runLeaseConformance`；server `RunRegistry` 接口化（`InMemoryRunRegistry` 缺省、`create` 异步）、`leasedRunRegistry`（心跳 ttl/3、丢租约 abort → paused(host)、结束 release、失败只告警）、`ActiveRun.onFinish`；store-pg `reins_runs` + `PgRunLease` 三条单语句、过期用库时钟；`createAgent` 自动装。+25 用例（含 PGlite 跨包用例），813 全绿。实施时与设计的三处出入见 DECISIONS 同日「D4 实施定形」
- [x] **D5 脱敏配方入 README**（2026-09-14）：根 README 新节 "Redacting what reaches the log"——工具结果在 `afterTool` 草稿上脱敏（放 sockets 最前，spill 搬进 blob 的才是干净的），其余事件包一层 `append`；配方原文即 `packages/brain/src/redaction.recipe.test.ts`，+3 用例锁住两条边界（顺序放错 blob 漏原文；包装管日志与模型视图但管不到 yield 出去的对象，SSE / onEvent 仍见原文）。不加接口；`redactingLog` 助手仍等 AdRate 接入时再议
- 不做（记 DECISIONS）：规范化 JSON 序列化算 digest 以放开 jsonb——改的是状态格式，等真有"全库禁 json"硬约束再随版本一起升

## lowering-fetch（2026-09-14 与 Boss 讨论立项，见 DECISIONS 同日「lowering-fetch 立项」；按顺序做，每步一个会话）

- [x] **F0 靶子体检**（2026-09-14）：`spikes/cf-gateway-fidelity` 暗号法 43/43，三条透传端点请求原样到厂商、响应与错误原文透传、缺省不缓存、六轮工具往返密钥注入稳定，伪造签名 / encrypted_content / 假 beta 头全拿到厂商原文 400；**CF 网关定为官方靶子**（DECISIONS 同日）。顺带实证 F2 摆放规则原文（中途 system 须紧跟 user）与三条非网关坑（踩坑记录）
- [x] **F1 骨架 + Chat Completions**（2026-09-14）：新包 `@reinsjs/lowering-fetch`（仅依赖 core、零 `node:*`，dist 自检过）；共用层 `http` / `sse` / `usage` / `models` / `ir`（事件 → IR：分组、后移、trust；落点按输入顺序排回），Chat 线 `encodeChatRequest` / `consumeChatStream` / `CHAT_LOSS_MATRIX`，工厂 `deepseek()` / `openaiChat()` / `chatCompletions()`；`payload.body` 即线上请求体，`HttpError` 对齐 SDK 格式让 core 瞬断判据直接适用。范围外发现：DeepSeek 带 tools 时 `reasoning_content` 写侧必回填（缺了 400），方言开关 `chat.reasoningContent`（DECISIONS「F1 定形」、踩坑记录）。+120 用例，936 全绿；`spikes/f1-chat-live` DeepSeek 直连与 CF 网关 gpt-4o-mini 各 8/8
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

- [x] **Cloudflare AI Gateway 验证靶子**（2026-09-14 Boss 已建，网关 `reins-dev`；轻测 Anthropic Messages / OpenAI Responses / OpenAI Chat 三条透传端点非流式均原样回暗号、Anthropic 流式透传；配置与路径写法在 `模型API测试信息.md` 末尾。REST `/ai/v1/*` 路径不适用——它要账户级 API token，透传路径才是我们要的）

- [ ] npm 组织 `reinsjs` 目前只有 `adrate-io` 一个 owner；若要让别的账号也能发版，在 npmjs.com/org/reinsjs 邀请
