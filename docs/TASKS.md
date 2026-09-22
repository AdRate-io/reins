# reins 任务板

> 活文档，只留**未完成**的任务与待 Boss 事项。开工顺序 = 从上往下第一个未勾选。
> 任务完成：打勾 + 一行结论（日期、关键结论、用例数）；实现细节写进 `docs/模块盘点/` 对应文件，踩到的坑写 `docs/踩坑记录.md`，决策写 `docs/DECISIONS.md`——**不要把实现记录堆进任务行**。
> 一个里程碑收口后，把已完成任务整段迁到 `docs/归档/<日期>-任务记录-<里程碑>.md`，本板始终短。
> 已完成记录：M0 / M1 / M2 见 `docs/归档/2026-09-10-任务记录-M0-M2.md`；0.1 发前清单与发布见 `docs/归档/2026-09-14-任务记录-0.1发布.md`。lowering-fetch F0～F4 见 `docs/归档/2026-09-15-任务记录-lowering-fetch.md`。

## 状态一句话

**0.2.1 已发布（2026-09-15；0.2.0 因 tarball 带 `workspace:*` 作废并 deprecate）**：12 个包在 npm 官方源，Release v0.2.1，从官方源真实安装冒烟通过。以下是 0.1 到 0.2 的记录——**0.1 已发布（2026-09-14，当前 0.1.1）**：11 个包在 npm 官方源 `@reinsjs/*`（总包 `@reinsjs/agent`；0.1.1 是只改文档的同号补丁，把 tarball 里的旧总包名改掉），源码在 GitHub `AdRate-io/reins`（Release v0.1.0），MIT，版权 NewRate Limited。788 个用例全绿。公开类型已冻结：改公开行为要走 changeset，破坏性变更升 minor。0.2 候选 D1～D5 全部完成（lazyTools、handler `onEvent`、approval `ttlMs`、跨进程 run 登记、脱敏配方，未发布），四个包各有 minor changeset 待 `changeset version`；0.2 等 AdRate 升 Node 22 后跑第一轮真实接入、把问题一起打进去再发（0.1.x 补丁并行）。**lowering-fetch F0～F4 全部完成（2026-09-15）**：三条线真模型各臂全通、最严档 workerd 实测 15/15、changeset 已备，随下次 `changeset version` 与 0.2 一起发；新宿主推荐 fetch 版，pi 版并存。**L1 lazy-tools 原生路径完成（2026-09-15）**：fetch 版 Anthropic 线取回工具不再打掉缓存前缀（spike 取回后第 2 请求 cache_read Haiku 8497 / Opus 4062，老路子 0），core / brain / lowering-fetch / lowering-pi / adapter / ui-agui 各有 changeset 待 `changeset version`。1218 个用例全绿。**四环境验证完成（2026-09-15）**：Bun / Deno / Vercel `edge-runtime` 与 Node 22 对照在同一探针、同一判据下全通（`spikes/runtime-matrix`），根 README 不再写 "not yet tested"。**TikTok MCP 接入准备完成（2026-09-15）**：实测确认其 layer 模式与「工具表 run 内不变」零冲突；补了 `auth` 口子与网关型服务器的审批红线，tools-mcp 一条 minor changeset。**运行时文案英文化完成（2026-09-15）**：0.1 遗留的最后一条，519 处字符串 + 181 处断言，12 个包各一条 minor changeset；约定已写进 `CLAUDE.md` 工程硬约束防回潮。**0.2 推送前外部审查处置完成（2026-09-15）**：两份报告（AGENTS 六路、Cursor 五路，原文在归档）共点 20 余项，实证后修了 12 项（README 过期声明、注释误替换、中文标点、`replay.phase` 回放、TanStack `deferredTools` 压回、配方一致性、四处文档漂移）、否了 1 项误报（TanStack 审批 ttl 用真引擎探针证实生效并转正为用例）、3 项记 DECISIONS 不改；1228 个用例全绿，产物 17/17。**示例切 fetch 版 + 门禁复跑完成（2026-09-15）**：五个 examples 与 eval 全部改用 `@reinsjs/lowering-fetch`，真模型冒烟五个示例全通；两族门禁：Sonnet 5 巡检与两族工具发现全过，DeepSeek 巡检 token 项 6 遍未过，三组对照（含 v0.1.1 原代码同日复跑）证实是 DeepSeek 一周内行为变化（同任务 6 轮变 10 轮）而非代码或降级层，照发并如实记录；顺带修了 fetch 版跨模型回放 thinking 签名 400 的真 bug。结果与对照见 `examples/eval/results/2026-09-15-lowering-fetch/`。**0.2.0 发布作废、0.2.1 重发（2026-09-15）**：0.2.0 用 `npm publish` 传的 tarball 带 `workspace:*` 装不上，同码 patch 到 0.2.1 用 `pnpm -r publish` 重发，0.2.0 已 deprecate；案卷见踩坑记录同日。

## 0.2 候选（2026-09-14 AdRate 接入评估提出，按顺序；全是加法，不改已发布形状；细节见 DECISIONS 同日"AdRate 接入六条评估"）

- [x] **D1 工具懒发现**（2026-09-14）：brain 第十个模块 `lazyTools()`，菜单进系统提示、`tool_find` 取回、已取回集合从时间线重建、直接调隐藏工具即 block 指路；+16 用例，eval fixture `tool-discovery`（200 件）+4 用例，780 全绿。spike：Anthropic 上取回后首请求缓存整段重写，频繁换任务按价目加权贵 1.7 倍，一次取回约 7 请求回本——opt-in、README 写边界。eval 两族门禁通过（第二轮，完成度 100% 持平，总 token −59%～−62%）。第一轮 fixture authId 类型缺陷见踩坑记录
- [x] **D2 handler 旁路观测钩子**（2026-09-14）：`HandlerOptions.onEvent(event, { sessionId, principal, request })` + `warn` 出口；只 live 不 replay、先广播再调不挡 run、出错只告警一次、run 收尾等观测链（Workers waitUntil 覆盖）；不进 core。+4 用例，784 全绿。server README 加 Observability 节、根 README 写明 `agent.run()` 本身可 `for await`
- [x] **D3 审批过期**（2026-09-14）：`approval({ ttlMs })`，比 `approval_request.at` 与宿主批准事件 `at`（循环时钟，不读墙钟），过期在 ask 落点 deny + block、留 `approval_decision(by: "approval.expired")`，模型看到"可重新发起"；`by` 用策略 id 而非 `"reins"`（理由见 DECISIONS）。+4 用例，788 全绿
- [x] **D4 跨进程 run 登记**（2026-09-14）：core `RunLease` 接口 + `InMemoryRunLease` + `runLeaseConformance`；server `RunRegistry` 接口化（`InMemoryRunRegistry` 缺省、`create` 异步）、`leasedRunRegistry`（心跳 ttl/3、丢租约 abort → paused(host)、结束 release、失败只告警）、`ActiveRun.onFinish`；store-pg `reins_runs` + `PgRunLease` 三条单语句、过期用库时钟；`createAgent` 自动装。+25 用例（含 PGlite 跨包用例），813 全绿。实施时与设计的三处出入见 DECISIONS 同日「D4 实施定形」
- [x] **D5 脱敏配方入 README**（2026-09-14）：根 README 新节 "Redacting what reaches the log"——工具结果在 `afterTool` 草稿上脱敏（放 sockets 最前，spill 搬进 blob 的才是干净的），其余事件包一层 `append`；配方原文即 `packages/brain/src/redaction.recipe.test.ts`，+3 用例锁住两条边界（顺序放错 blob 漏原文；包装管日志与模型视图但管不到 yield 出去的对象，SSE / onEvent 仍见原文）。不加接口；`redactingLog` 助手仍等 AdRate 接入时再议
- 不做（记 DECISIONS）：规范化 JSON 序列化算 digest 以放开 jsonb——改的是状态格式，等真有"全库禁 json"硬约束再随版本一起升

## 0.1 之后（纯新增或有外部依赖）

- [x] **四环境验证**（2026-09-15）：`spikes/runtime-matrix/` 六臂（Node 对照 / Bun 1.4 / Deno 最小权限 / Deno +sys / Vercel `edge-runtime` 裸 vm / +process.env 垫片）托管 workerd 探针同一处理器打 dist，每格内容核对：fetch 版三条线四运行时真模型全通；pi 版全通的三个宿主条件全在上游——Deno `--allow-sys=osRelease`（pi-ai UA 读 `os.release()`）、Edge 要 `process` 全局（openai SDK 裸读 `process.version`）、Bun `idleTimeout` 过缺省 10 秒。库代码未改，四份 README 的 Runtime 段更新；同日下午用 Boss 的 Hobby 账号真部署 Vercel Edge 7/7（线上自带 `process`，pi 版 OpenAI 路径直接通）
- [x] **tools-mcp 接 TikTok for Business 的三件**（2026-09-15，真需求来自 AdRate 要接 TikTok 官方 MCP）：`httpTransport({ auth })` 令牌每请求现取 + 401 刷新重试一次（不收 SDK 的 `OAuthClientProvider`、不暴露 SDK 类型）；网关型服务器的审批红线写进 README + 配方 `packages/brain/src/gateway-tool.recipe.test.ts`（含反面用例）；`tool_list` 大结果用 `override` 调 `resultPolicy`（无需改代码）。+6 用例，1224 全绿。实测原文存档 `docs/归档/2026-09-15-实测-TikTok官方MCP.md`，结论与边界见 DECISIONS 同日
- [ ] tools-mcp 其余：sampling / elicitation / resources / prompts、驱动浏览器授权的完整 OAuth 流程，仍待真需求（"历史含已移除工具"官方 Anthropic 已于 2026-09-15 经 CF 网关补测接受，见 `spikes/l1-deferred-tools/` P8）
- [x] **MCP 工具进 lazy-tools 菜单**（2026-09-22，0.3 第一项；真需求：AdRate 接 TikTok MCP flat 模式，按 `readOnlyHint` 剔写工具后仍约 200 件只读）：core `SocketSetup.tools`（到本 Socket 为止已并入的工具表，每 Socket 一份快照）+ lazy-tools 菜单与同名检查改看它 + 顺序反了告警一次；tools-mcp 不加接口，README 新节 + 配方用例（只读 → lazy、`{code≠0}` 转 isError、反面顺序用例）。+6 用例，1237 全绿，dist 17/17；core / brain minor、tools-mcp patch 各一条 changeset。设计见 DECISIONS 2026-09-22。**待 AdRate 侧用真 TikTok MCP 跑一次接入验证**
- [ ] memory 挂载表（共享只读 + 私有可写，技术方案 §9.6）——等团队场景真出现"同时挂两块"再做
- [ ] DeepSeek 上 brain-lean 的巡检 token 项（PRD §7 门槛 2）2026-09-15 起不过：轮次 6.3 → 10 是模型自己变的（四版代码一致）；英文化后每轮上下文 2.8 万 → 3.5 万未排除（n=6 分不出）——① 量英文化后 pin / spill / memory 确认句在 DeepSeek 分词下的长度与每轮上下文由哪些事件撑大；② 研究 approval / perception 规则文案能否让模型一次问完一批写操作；改完两族各 12 遍复测
- [ ] lowering-fetch Anthropic 线：连续两条中途 system 消息（`flushNotes` 每条说明各成一条）厂商是否接受，未实证——补进 `spikes/f0-*` 的 A 组跑一次真模型；被拒就在 `flushNotes` 合成一条多块 system（落点照记）
- [x] **L1 lazy-tools 的 provider 原生路径**（2026-09-15）：core `ContentPart` 加 `tool_reference` 段（带定义快照）、`ToolSpec.deferLoading` / `LoweringCapabilities.deferredTools` / `BeforeModelPatch.deferredTools`；lazy-tools 按能力位分原生 / 过滤两路；fetch 版 Anthropic 线 `defer_loading` + `tool_reference` 块（GA 无 beta 头，Haiku 4.5 起），厂商规矩落进 encoder；其余线与 pi 版展开成文本、不发 deferLoading 的工具。spike：取回后第 2 请求 cache_read Haiku 8497 / Opus 4062，老路子归零；端到端 Haiku / Opus 各 9/9；取回之前被延迟的定义不进计费前缀（P9 六臂 6/6，删件臂整段命中带标臂）。`lazyTools()` 接口不变。+33 用例，1218 全绿；MCP 工具懒发现仍待 `SocketSetup` 加"此前已并入的工具"
- [x] **运行时告警与构造期错误文案英文化**（2026-09-15）：实际不是「十几处」而是 **519 处字符串字面量 + 181 处测试断言**。改的是宿主 / 模型会看到的一切——`throw` 消息、`warn()` 文案、模型可见的 tool_result 说明、三条降级线与适配器的有损矩阵 `note` / `when`、协议装不下内容的占位文本、`core/testing` 四套一致性套件、eval 报告与门禁；注释 / JSDoc / 测试标题 / examples / docs 保持中文（边界与理由见 DECISIONS 同日）。零结构改动，1218 个用例全绿，产物自检 17/17；12 个包各一条 minor changeset

- [ ] 工具批并发执行（0.3 候选，**不排期**）——现状串行是宪法二的后果，不是疏漏；要做则限死「整批 beforeTool 全 proceed 才并发、结果按原顺序 append」。等真出现「多个慢的只读工具并列」的场景 + eval 数据再议，理由见 DECISIONS 2026-09-21

## 待 Boss 本人操作（不挡开发）

- [x] **Cloudflare AI Gateway 验证靶子**（2026-09-14 Boss 已建，网关 `reins-dev`；轻测 Anthropic Messages / OpenAI Responses / OpenAI Chat 三条透传端点非流式均原样回暗号、Anthropic 流式透传；配置与路径写法在 `模型API测试信息.md` 末尾。REST `/ai/v1/*` 路径不适用——它要账户级 API token，透传路径才是我们要的）

- [ ] npm 组织 `reinsjs` 目前只有 `adrate-io` 一个 owner；若要让别的账号也能发版，在 npmjs.com/org/reinsjs 邀请
