# 决策日志

> 约定：技术与产品决策由技术合伙人做出并记录于此，Boss 随时可读、可否决。只有需要 Boss 本人账号、资金或业务背景的事项才会单独请示。每条含日期、决策、理由、可逆性。

| 日期 | 决策 | 理由 | 可逆性 |
| --- | --- | --- | --- |
| 2026-09-08 | 项目定位采纳 PRD v1.0 两条宪法：决策权默认在模型；时间线是唯一真源 | Boss 反复确认这是理念而非功能；调研证明此立场无库占据 | 低，是根基 |
| 2026-09-08 | 形态为"整车"：自带 pi 大小的循环 + 预装脑子 + 标准插座，脑子可脱离底盘用 | Boss 提出；脑子与底盘共设计才能落到最顺位置 | 中 |
| 2026-09-08 | 命名 **reins**，npm 包 `reins`，scope `@reins/*`（不可用则 `@reinsjs`） | 对应"把缰绳交给模型"；npm 裸名与 GitHub 组织名 2026-09-08 均空闲；备选 `annals` | 高（发布前） |
| 2026-09-08 | 开源协议 MIT | 生态一致（pi、dsh、TanStack、OpenClaw 均 MIT），采纳阻力最低 | 低（发布后） |
| 2026-09-08 | 语言 TypeScript，核心仅 Web 标准 API，运行时不限于 Node | 目标用户与复用生态均为 TS；跨语言走协议不走移植 | 低 |
| 2026-09-08 | 第一个也是第一期唯一的 dogfood 宿主：Boss 的投放工具 | 有真实长任务与真实用户；eval fixture 来源 | 高 |
| 2026-09-08 | eval 模型档位：主用 Claude Opus 5（支持 task budget，便于对照）；成本基线另用一档便宜模型；机制本身不依赖 task budget | 调研核实仅 Opus 5 / Fable 5.1 支持 task budget | 高 |
| 2026-09-08 | 降级层复用 pi-ai，pin 精确版本，隔离在 `@reins/lowering-pi` | 两万四千行协议代码不自养；v0.1 D6 | 中 |
| 2026-09-08 | 实施方式：按 TASKS.md 拆任务包（≤1 天、有验收），先做 4 项核实 spike 再写核心 | 技术方案有待核实项；Boss 需可见的小交付 | 高 |
| 2026-09-08 | 起步只建三个包：`@reins/core`、`@reins/brain`、`@reins/lowering-pi`，其余按需拆 | 避免为拆包付管理成本 | 高 |
| 2026-09-08 | 第一期节奏 M0 骨架 2 周、M1 脑子 3 周、M2 数字 2 周；以 eval 达标为准不以日历为准 | 技术方案 §16 | 高 |
| 2026-09-08 | 代码仓库先建本地 `~/Desktop/reins`，发布前再推远程公开；文档与决策日志留在 `Agent-SDK方案/`，发布时并入仓库 `docs/` | Boss 指示；避免半成品公开 | 高 |
| 2026-09-08 | 旧文档移入 `docs/归档/`，开发期只读 PRD、技术方案、本日志 | Boss 要求避免冗余信息 | 高 |
| 2026-09-08 | 全部文档并入仓库 `docs/`，原 `Agent-SDK方案/` 目录废弃 | Boss 要求不在两个目录间切换 | 高 |
| 2026-09-08 | **S4** pi-ai pin `@earendil-works/pi-ai@0.85.1`。原 `@mariozechner/pi-ai` 停在 0.73.1 并标记 deprecated，仓库迁至 earendil-works/pi。只从 `api/<api>`（流函数）与 `providers/<name>.models`（静态模型表）子路径导入；不用 `compat` 入口（上游注明为临时层、将删除），不用 `providers/all`（拉入 Bedrock 与 AWS SDK）。pi-ai 的 Message/Context/Tool/Model/AssistantMessageEvent 只在 lowering-pi 内部出现 | 主包已迁移；核心路径对 `node:*` 全部用动态可选加载，具备 Workers 可行性（T12 再实测） | 中 |
| 2026-09-08 | **S1** Anthropic 官方已支持带正文的中途 `role:"system"` 消息：Fable 5.1/5、Mythos 5.1/5、Opus 5/4.8，无需 beta 头；Sonnet 5 及更早不支持。摆放规则：不能是首条，必须紧跟 user 轮（含 tool_result 的 user），后接 assistant 或收尾，否则 400；连续 system 视为一组。pi-ai 0.85.1 的 Message 无 system 角色，仅在 `supportsMidConvoEffort` 模型上发 content 为空的 effort 专用 system 消息。**决策**：投影层把 `system_note` 落为带内部标记的 user 消息；lowering-pi 用 pi-ai 公开的 `onPayload` 钩子在支持的模型族上改写为 `role:"system"` 文本消息并按摆放规则归位（紧贴最后一条 user 之后）；不支持的模型保留 user 角色。`capabilities.midConversationSystem` 按模型族声明，有损矩阵记录两种落点 | 实测见 `spikes/s1-mid-system`；用公开钩子不 fork pi-ai | 中：上游若加入 system 角色则删除改写逻辑 |
| 2026-09-08 | **S2** TanStack AI 0.53.0：`onConfig` 返回的 Partial 可同时含 `providerMessages` 与 `systemPrompts`（浅合并；只返回 `messages` 时框架自动同步 `providerMessages`）；init 与每轮 beforeModel 都调用，`config.messages` 是含 tool 结果的完整历史。`ModelMessage.role` 只有 user/assistant/tool，无 system → TanStack 路径下 `system_note` 只能落 user 角色或追加 `systemPrompts`（改动缓存前缀），有损声明。`MetadataStore` 是需中间件在 `setup` 里 `provide` 的命名空间 KV（async get/set/delete），无默认实现 → 适配器**不**用它存 run 状态，状态引用放 EventLog。审批暂停走 `onInterruptBoundary`，预算走 `onShouldContinue`/`onUsage`，模型事件记录走 `onChunk` | 读上游 dist 类型与 compose.js 源码 | 中 |
| 2026-09-08 | **S3** `@reins/store-sqlite` 首版驱动用 `node:sqlite`（Node 22.13+ 免 flag，官方稳定性 1.2 候选发布，本机 22.20 实测可用）；Bun 用 `bun:sqlite`（同为同步 API，SQL 层共用，驱动按运行时选择）；Cloudflare 不做 SQLite 文件包，用 Durable Objects SQLite（`ctx.storage.sql.exec`）单独做 `@reins/store-do`，第二期。**不用** better-sqlite3（原生编译、装机负担）与 sqlite-wasm（Node 下仅内存、无持久化） | 零原生依赖；一份 SQL 三个驱动 | 高 |
| 2026-09-08 | lint 与格式化用 Biome 2.5.12（单一工具、零插件）；提交信息校验用零依赖的 `.githooks/commit-msg`，由 `pnpm install` 的 prepare 自动挂载；不引入 ESLint/Prettier/husky/commitlint | 工具链越少越好，三个月后仍能一眼看懂 | 高 |
| 2026-09-08 | **T3** 事件载荷统一放 `payload` 字段（不平铺到事件顶层）；`trust` 缺省按 actor 推导（tool→untrusted）；`EventSchemaRegistry` 在登记时就校验升级链完整（version=n 必须有 1..n-1 全部 upcaster）；uuidv7 自实现不引依赖；payload 形状在读取时不做运行时校验，只校验壳与版本 | 壳稳定则升级函数只碰 payload，三个月后加字段不会牵连 EventBase；启动即报错优于读到一半才发现；payload 校验交给写入方与工具 inputSchema，避免核心包绑定校验库 | 高（发布前） |
| 2026-09-08 | **T4/T5** EventLog 的 seq 由调用方分配、日志只校验连续性（乐观并发）；fork 保留原事件 id（id 唯一性范围改为"会话内"）；一致性套件不依赖任何测试框架的 expect，只接收 `{ describe, it }`，断言自带；core 增加 `./testing` 子路径导出，tsup 多入口时 DTS 关闭 composite | 存储层不做主，循环层才知道 seq 该是多少；保留 id 才能让 parentId / pinsKept 在分叉会话里继续有效；不绑 vitest 让 Bun、Node 原生测试都能跑套件 | 高（发布前） |

## 待 Boss 本人操作

- [ ] M2 发布前：在 GitHub 创建组织 `reins` 并授权推送（或授权我用现有账号创建并转移）
- [ ] M2 发布前：在 npm 创建组织 `reins`
- [ ] M1 B11：从投放工具里选一条真实长任务流程作为 dogfood
