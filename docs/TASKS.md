# reins 任务板

> 活文档，只留**未完成**的任务与待 Boss 事项。开工顺序 = 从上往下第一个未勾选。
> 任务完成：打勾 + 一行结论（日期、关键结论、用例数）；实现细节写进 `docs/模块盘点/` 对应文件，踩到的坑写 `docs/踩坑记录.md`，决策写 `docs/DECISIONS.md`——**不要把实现记录堆进任务行**。
> 一个里程碑收口后，把已完成任务整段迁到 `docs/归档/<日期>-任务记录-<里程碑>.md`，本板始终短。
> 已完成的 M0（骨架）/ M1（脑子 v1）/ M2（数字）全部记录见 `docs/归档/2026-09-10-任务记录-M0-M2.md`。

## 状态一句话

M0、M1、M2 主体已完成（2026-09-08 ～ 09-10）：11 个包、约 3.2 万行 TS、760 个用例全绿；PRD §7 门槛 2 两族达成，compact 推荐默认；P1 MCP、P2 记忆隔离、P3 子代理范式、R9 trust 标注全部落地。**2026-09-10 Boss 定：先清完"发前清单"再一起发 0.1**（筛选规则见 DECISIONS 同日"发包 = 冻结公开接口"）。**2026-09-13 变更程序：** Boss 以产品所有者身份定 0.1 必须含 Skill，清单解封一次追加 **S1** 后重新封口；S1 同日落地（brain 第九个模块 `skills` + `@reinsjs/brain/node`），发前清单只剩 E4 等 Boss 操作。

## 0.1 发前清单（按顺序，已封口 2026-09-10；2026-09-13 按变更程序追加 S1 后重新封口）

筛选规则：会改公开类型或默认行为的、规划清晰且无外部依赖的，发前做；纯新增的发后做。

- [x] **R5** TanStack 导入幂等键 —— 2026-09-10 落地：键 = 消息 id 或客户端数组位置，内容逐字相同才算重发，同键不同内容放行；+4 用例（686 全绿）。细节：`模块盘点/adapter-tanstack-ai.md`「客户端历史只导入新的那一截」、DECISIONS "R5" 行
- [x] **R7** 审批中断漏登记的运行时检查 —— 2026-09-10 实现（不是改注释）：init 读引擎登记表，没登记则告警一次、需审批调用降级为拒绝并留痕；反向验证旧代码会被引擎抛错打死；+1 用例（687 全绿）。细节：`模块盘点/adapter-tanstack-ai.md`「动态审批落成通用中断」、DECISIONS "R7" 行
- [x] **R3** 瞬断判定状态码优先 —— 2026-09-10：结构化 status / 文案开头状态码 / SDK 连接类名 / `x-should-retry` 先定，408/409/429/5xx 与 SDK 同策略，关键词只兜没有状态码的错误且不再匹配裸数字；+1 用例（688 全绿）。细节：`模块盘点/core.md` retry.ts 行、DECISIONS "R3" 行
- [x] **R4** 投影新造事件冲突 —— 2026-09-10 定"不重跑、抛 StoreError 交宿主"，注释与技术方案 §6 改成如实描述。理由见 DECISIONS "R4" 行
- [x] **R8** pg 用例标题 —— 2026-09-10 改为"json 列往返不改内容，本包刻意不用 jsonb"
- [x] **`asTool(agent, opts)` 助手** —— 2026-09-10 落地（`reins` 包）：`Interruption` 加 `kind: "subagent"`、`ApprovalDecisionInput.sessionId?`、`ToolContext.decisions? / spend?`、core `subagentPause` 标记；审批冒泡跨进程续跑与预算合算各有用例（core +3、reins +4，695 全绿）；`examples/team` 改用 asTool，手写版留 `subagent-tool.handwritten.ts` 对照。设计见 DECISIONS "asTool" 行、技术方案 §6 补充与 §10.1 落地段。未做：真模型复跑 examples/team（专家全只读，冒泡路径真模型下无从触发）
- [x] **S1 Skill 支持（Agent Skills 的加载与渐进式披露）** —— 2026-09-13 落地：core `SkillSource` + `Tool.resultTrust`；brain `skills({ source, root?, maxReadChars?, rules? })`（菜单 + `skill_read`，缺 source / 空菜单不注册）、`inlineSkills`、`@reinsjs/brain/node` 的 `fsSkillSource`；memory 的路径规范化与 view 抽成 `shared/` 共用；`examples/adrate` 改成菜单 + 翻书，DeepSeek / Claude 两族真跑都先 `skill_read` 再动手（trust=system），据实测把 `maxReadChars` 缺省定为 40k；+49 用例（751 全绿），`check:dist` 16 入口过。细节：`模块盘点/brain.md` skills 节与决策、技术方案 §9.9"实现"、DECISIONS 2026-09-13 三行、踩坑记录同日两条
- [ ] **E4** 0.1 发布 —— S1 已落地（2026-09-13），同日两个只读审查子代理（安全 / 正确性、接口 / 文档 / 发布就绪）做完发前审查：无阻断项，5 条应修 + 若干建议逐条核实后全部处置（DECISIONS "S1 发前双审查处置"行，+9 用例，760 全绿，`check:dist` 16 入口过）。2026-09-10 发前准备已做完：11 个包英文 README、changeset → 0.1.0 + CHANGELOG 首条、每包 LICENSE、`pnpm check:dist` 产物自检（15 个入口全过）、根 README 改 0.1.0（DECISIONS "E4" 行）。2026-09-10 下午两份外部审查（cursor / Grok，报告在 `归档/`）逐条核实：修 handler 子代理审批预校验、MCP 连接 close 竞态、`@tanstack/ai` 改 peer、版本常量 0.0.0 → 0.1.0（check:dist 核对）、eval README 假示例、运行时支持措辞、server README 白名单描述等，+7 用例（702 全绿）；lowering-pi 进阶 API 暴露 pi-ai 类型书面豁免（DECISIONS）。2026-09-14 账户 / 许可证 / 改名 / 脱敏四项已清（DECISIONS 同日五行）。**剩下只等 Boss**：GitHub 仓库 / npm 组织建好后 `git remote add` + push，`pnpm changeset publish`（`repository` / `homepage` / `author` 2026-09-14 已填，版权归 NewRate Limited，许可证定为保持 MIT）

## 0.1 之后（纯新增或有外部依赖）

- [ ] `@reinsjs/lowering-fetch` 零依赖降级层（装机 65 M 的 pi-ai 之外的可选项）——新包，不动已有接口
- [ ] 四环境验证：Bun / Deno / Vercel Edge 未实测（edge-runtime-check 只测了 Cloudflare workerd）——验证不改接口
- [ ] tools-mcp 后续：官方 Anthropic 直连对"历史含已移除工具"的接受度未测（无 key；DeepSeek Anthropic 协议与 OpenAI Responses 已实测接受）；OAuth 流程、sampling / elicitation / resources / prompts 待真需求
- [ ] memory 挂载表（共享只读 + 私有可写，技术方案 §9.6）——等团队场景真出现"同时挂两块"再做
- [ ] 运行时告警与构造期错误文案英文化（全包十几处字符串，含 memory / spill / budget / skills）——审查指出英文 README + 中文告警对非中文用户是死路；0.1 保持中文（DECISIONS 2026-09-13）

## 待 Boss 本人操作（不挡开发，挡发布）

- [x] GitHub 公开仓库 `AdRate-io/reins` 已建（2026-09-14，带一条初始化提交，推送时以本地 main 覆盖）。**仍需**：本机 `gh auth login` 或 `git` 凭证能推该仓库
- [x] npm 组织已建：`reins` 不可用，建了 `reinsjs`（2026-09-14），11 个包已改名 `@reinsjs/*`、总包仍 `reins`。**仍需**：发布当天本机 `npm login`（账号 `adrate-io`），publish 时输 2FA 验证码
- [x] 录像脱敏 —— 2026-09-14 Boss 批准方案 A：全历史 `filter-repo --replace-text` 换掉 236 个真实值（零残留、72 提交不变），S1 三份录像脱敏入库，原件只在本地 `recordings/raw/`，备份 bundle 在仓库外。细节：DECISIONS 同日「录像脱敏处置」行、踩坑记录同日、`examples/adrate/README.md`「录像与脱敏」

## 已完成（2026-09-10，待里程碑收口时迁归档）

- [x] **P1 `@reinsjs/tools-mcp`** —— 新包 20 用例 + core `tools_bound` 与静态贡献异步化；官方 client 2.0.0 主入口零 `node:*`，最严档 workerd list + call 通过；`examples/mcp` 用 DeepSeek 跑通真实任务（录像 `recordings/restock-below-threshold.jsonl`）；两条协议对历史含已移除工具均接受。细节：`模块盘点/tools-mcp.md`、DECISIONS 2026-09-10 四行、踩坑记录"一个 MCP HTTP 服务端传输只服务一个会话"
- [x] **P2 memory 隔离收口** —— `memoryTable` / `table` 选项只换记忆表名，表名白名单防注入且不合规不碰库，两包 +4 用例，dist 冒烟通过；README 新增 "Memory and how to isolate it"。细节：`模块盘点/store.md`、DECISIONS "P2" 行
- [x] **P3 子代理手写范式** —— `examples/team/` 编排者 + 分析师（linked）+ 文案（detached）共用 pg（PGlite）存储、记忆按 namespace 分角色再分用户；`subagent-tool.ts` 逐条标号五件事，5 个脚本化用例；DeepSeek 两次跑通真实任务，`replay.ts` 只凭父录像找到子会话并核对用量一致。不改 core。细节：示例 README、技术方案 §10.1、DECISIONS "P3" 行
- [x] **R9 trust 标注落地** —— core `lowering/trust.ts` 一份纯函数（`<untrusted source="tool:<name>">…</untrusted>`，只包文本，`</untrusted` 转义记 lossy），lowering-pi 与 TanStack 适配器共用，缺省开、`trustMarkers: false` 可关；线协议请求体含标记且事件 payload 不变；DeepSeek 复跑 examples/team 行为不受影响。细节：技术方案 §14、DECISIONS "R9" 行、模块盘点 core / lowering-pi / adapter
