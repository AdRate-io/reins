# reins 任务板

> 活文档，只留**未完成**的任务与待 Boss 事项。开工顺序 = 从上往下第一个未勾选。
> 任务完成：打勾 + 一行结论（日期、关键结论、用例数）；实现细节写进 `docs/模块盘点/` 对应文件，踩到的坑写 `docs/踩坑记录.md`，决策写 `docs/DECISIONS.md`——**不要把实现记录堆进任务行**。
> 一个里程碑收口后，把已完成任务整段迁到 `docs/归档/<日期>-任务记录-<里程碑>.md`，本板始终短。
> 已完成的 M0（骨架）/ M1（脑子 v1）/ M2（数字）全部记录见 `docs/归档/2026-09-10-任务记录-M0-M2.md`。

## 状态一句话

M0、M1、M2 主体已完成（2026-09-08 ～ 09-10）：10 个包、约 3.1 万行 TS、644 个用例全绿；PRD §7 门槛 2 两族达成，compact 改为推荐默认。剩下 0.1 发布前的四项与发布本身。

## 0.1 发布前（按顺序）

- 2026-09-10 Boss 设想"多角色 agent 团队"（各角色自己的系统提示 / 工具 / 记忆，会话在数据库）后追加，设计见技术方案 §9.6 隔离设计、§10 MCP、§10.1 子代理即工具；已讨论并记录决策，未实施：
  - [ ] **P1 `@reins/tools-mcp`**（0.1 必备，Boss 定：自用环节要一个能力完整的库，MCP 提前到 E4 之前）—— ① 核实 `@modelcontextprotocol/client@2.0.0` 的导出面（Client、Streamable HTTP 与 stdio 传输各在哪个入口、`node:*` 依赖分布），结论进 DECISIONS；② `mcpTools(options): Socket`，`tools` 为静态贡献函数：run 起步 `tools/list` 一次 → `Tool[]`，`tools/call` 结果 content 翻 ContentPart、isError 直通，annotations → risk / needsApproval 缺省；③ 主入口只 Streamable HTTP、`/node` 子路径才有 stdio，主入口零 `node:*`（沿用 `spikes/edge-runtime-check` 最严档判据跑一遍）；④ 用官方示例服务器或自写最小服务器做集成测试：列表、调用、isError、断连不崩、`listChanged` 只影响下次 run；⑤ 与 spill / approval 同装跑一条：超长结果外溢、destructiveHint 工具停下等审批。⑥ **免重启**：示例里 MCP 配置从库（或文件）按请求读，改配置后下一次请求生效，进程不重启；同时写一条测试锁住"暂停中换工具表 → 续跑被判配置漂移、`allowConfigDrift` 可放行"的既有行为并在 README 说明；⑦ **工具表变化告知模型**（core 小改，Boss 定默认开）：新事件 `core.tools_bound`（模型不可见）每次 run 起步一条，与上一条比对有增删则追加模型可见的 `system_note(kind=host)` 列出增删的工具名；首次 run 不出说明；事件类型带 schemaVersion 进注册表；⑧ **实测**两条协议在历史含已移除工具的调用时是否接受请求，结论进 DECISIONS 并决定平台策略是否要"删工具新会话生效"的不对称规则。验收：examples 里一个 agent 同时挂进程内工具与 MCP 工具跑通一条真实任务；README 写清连接生命周期、免重启的原理与"不做动态注册"
  - [ ] **P2 memory 隔离收口**（0.1，小）：`PgMemoryStore` / `SqliteMemoryStore` 表名可配置（缺省 `reins_memory`，`pgStores` / `sqliteStores` 透传，建表语句同步）；README 记忆一节写三层隔离与三段示例（共用 / 按角色 / 按角色再按用户）。挂载表（共享只读 + 私有可写）**不做**，等团队场景真出现"同时挂两块"再做
  - [ ] **P3 子代理手写范式**（0.1，文档 + 示例，不改 core）：`examples/team/` 两个角色（编排者 + 专家）共用一套 pg 存储、各自 systemPrompt / tools / 记忆前缀；专家以 `Tool` 形式挂在编排者工具表上，逐条示范 §10.1 的五件事（联停与否由使用者定：示例同时给"父停子停"与"接力不联停"两种写法、principal、sessionId 关联、子用量汇总、子 paused 的处理）；跑一条真实任务留录像。验收：回放父会话能按记录的 sessionId 找到子会话
  - 0.2（发布后，已写进 §16 M3）：`asTool(agent, opts)` 助手 —— 审批冒泡（`Interruption.kind="subagent"`，子状态随父状态序列化）与预算合算；memory 挂载表按需
- [ ] **R9 trust 标注落地**（0.1 前，2026-09-10 盘点发现的安全默认值缺口）：技术方案 §14、DECISIONS T6、`core/src/projection/filter.ts` 注释都说"工具输出与外部内容 trust=untrusted，由降级层包裹显式标记"，但 `lowering-pi` 与 `adapter-tanstack-ai` 里都没有任何 trust 处理，`toPiContent` 原样搬运。做法：事件已带 `trust` 字段，两条协议翻译文本时按它包裹（形如 `[untrusted content from tool X] … [end]`，具体文案定了进 DECISIONS），图片不包；TanStack 适配器 `toModelMessages` 同样处理；用例断言包裹出现在请求体且 tool_result 事件本身不变（投影不篡改 payload）。若决定 0.1 不做，必须把 §14 与注释改成"未实现"，不能留空头支票
- [ ] E4 文档、CHANGELOG、0.1 发布准备（远程仓库与 npm 组织在此之前建，见"待 Boss"）—— 含每个包的 README（对外，英文）、CHANGELOG 首条、changeset、`pnpm build` 产物 import 自检、根 README 状态从 Pre-alpha 改 0.1

## 0.1 之后

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
