# reins 任务板

> 规则：每个任务包 ≤ 1 个工作日，有明确验收；完成后打勾并写一行结果。技术方案 §16 的里程碑在此展开。Boss 只需看"验收"列能不能看到东西。
> 代码仓库：`~/Desktop/reins`（本地，发布时再推远程）。文档在 `docs/`。

## M0 骨架（目标 2 周）：能跑、能回放、能在 Workers 上起 handler

### 阶段 0：进代码前的核实（1~2 天，结论写入 docs/DECISIONS.md）

- [x] S1 pi-ai 对 Anthropic 中途 system 消息的支持；不支持则 `system_note` 降为 user 角色并在 capabilities 声明 —— 验收：一段实测代码与结论（2026-09-08 完成：官方 API 支持，pi-ai 不支持；用 `onPayload` 改写补齐，脚本在 `spikes/s1-mid-system`）
- [x] S2 TanStack AI `onConfig` 能否同时替换 providerMessages 与注入 systemPrompts；`metadata` store 形状 —— 验收：结论 + 适配器接口草案调整（2026-09-08 完成：可以同时返回；MetadataStore 无默认实现，不用它存状态；钩子映射写入技术方案 §2）
- [x] S3 SQLite 实现选型：better-sqlite3 / node:sqlite（Node 22 内置）/ sqlite-wasm —— 验收：选一个并说明 Bun 与 Workers 上的替代（2026-09-08 完成：node:sqlite；Bun 用 bun:sqlite；Workers 用 Durable Objects SQLite 另起包）
- [x] S4 pi-ai 精确版本与其 Message/Context 类型边界确认 —— 验收：pin 版本号写入 DECISIONS（2026-09-08 完成：`@earendil-works/pi-ai@0.85.1`，旧 scope 已 deprecated；只从 `api/*` 子路径导入）

### 阶段 1：仓库与工程

- [x] T1 pnpm monorepo 骨架：core / brain / lowering-pi 三包、TS 严格模式、vitest、tsup、changesets、MIT、README 首屏写宪法 —— 验收：`pnpm i && pnpm test` 通过（2026-09-08 完成）
- [x] T2 CI 脚本（本地 `pnpm check`：typecheck + lint + test）与提交约定 —— 验收：一条命令全绿（2026-09-08 完成：Biome 做 lint+format，`.githooks/commit-msg` 校验 `type: 摘要`，GitHub Actions 同跑 `pnpm check`，约定见 CONTRIBUTING.md）

### 阶段 2：核心数据与存储

- [x] T3 事件模型：EventBase、core.* 类型、schemaVersion、upcast 表、fail-closed 读取 —— 验收：类型测试 + 一个 v1→v2 升级用例（2026-09-08 完成：15 种 core.* 全 v1；`EventSchemaRegistry` fail-closed 五类错误码；v1→v2 与三级链升级用例；类型测试 `types.test-d.ts`；19 个测试全绿，core 零 `node:` 引用）
- [x] T4 Store 接口：EventLog / BlobStore / MemoryStore + 内存实现 —— 验收：接口一致性测试套件对内存实现全绿（2026-09-08 完成：三个接口 + `StoreError` 七类错误码 + 内存实现；套件 27 用例全绿；用故意不校验 seq 的坏实现验证套件能报红 5 项）
- [x] T5 一致性测试套件导出为 `@reins/core/testing`，供第三方后端复用 —— 验收：套件可独立 import 运行（2026-09-08 完成：构建后用 `node:test` 作 harness 从 dist 导入跑通 27/27，证明不绑 vitest）

### 阶段 3：投影与降级

- [x] T6 Projection 策略链：过滤 → 折叠 → 钉住 → 感知注入（占位）→ 预算裁剪；纯函数 —— 验收：给定时间线快照，输出确定且有单测（2026-09-08 完成：`packages/core/src/projection/`，四个内置策略 + `perception` 插槽；`project()` 同步纯函数，新造事件走 `emitted`；31 个用例全绿，含确定性、嵌套折叠、pin 幸存、工具配对不拆、seq 封闭、overBudget）
- [x] T7 `@reins/lowering-pi`：事件 → pi-ai Message → 请求；流式响应 → 事件；capabilities；有损矩阵落地 —— 验收：Anthropic 与 OpenAI Responses 各跑通一次带工具调用与 thinking 回放的往返（2026-09-08 完成：core 增加 `Lowering` 接口、`EventDraft`、有损矩阵类型；`PiAiLowering` 只从 pi-ai `api/*` 与 `providers/*.models` 导入；system_note 经 `onPayload` 改写为 Anthropic 中途 system 并按官方规则归位、OpenAI 落 developer；用假 fetch 断言两家请求体（thinking 签名 / reasoning item 回放、tool 配对、system 归位、store:false）与假 SSE 译回草稿，13 用例全绿。**真实联网往返待 Boss 提供 key**：`pnpm build && ANTHROPIC_API_KEY=... OPENAI_API_KEY=... node spikes/t7-live-roundtrip/live.mjs`）
- [x] T8 有损声明测试：每种事件在两家 API 的落点有断言，禁止静默丢弃 —— 验收：矩阵测试全绿（2026-09-08 完成：`LOSS_MATRIX` 覆盖 15 种 core 事件 + ext.* × 两家 API；`loss-matrix.test.ts` 用 19 个变体 × 4 个模型目标逐条断言实际落点必在声明内，并反向检查矩阵无死条目，77 用例全绿）

### 阶段 4：循环与运行状态

- [ ] T9 `runLoop` 异步生成器 + Socket 五个钩子 + RunResult 四态 —— 验收：一个带工具的 agent 跑三轮并结束；日志可完整回放
- [ ] T10 RunState 序列化 / 恢复 + 审批暂停（`paused`）跨进程续跑 —— 验收：进程 A 暂停、进程 B 恢复的测试
- [ ] T11 fork：任意 seq 分叉出新会话 —— 验收：分叉后两条会话独立演进

### 阶段 5：服务端与前端

- [ ] T12 `@reins/server` `createAgentHandler`：Web 标准 handler、SSE、`lastSeq` 重连补发 —— 验收：Node 与 Cloudflare Workers（miniflare）各跑通
- [ ] T13 `@reins/ui-agui` 事件映射 —— 验收：映射表测试；一个最小 HTML 页面消费流
- [ ] T14 示例应用 `examples/minimal`：五分钟体验代码原样可跑 —— 验收：PRD §5.1 代码块复制即用

### 阶段 6：M0 收口

- [ ] T15 回放演示：从事件日志重放一次完整会话并展示 —— 验收：Boss 能看到"发生过什么"的时间线
- [ ] T16 M0 复盘：更新技术方案与 DECISIONS —— 验收：文档与代码一致

## M1 脑子 v1（目标 3 周）

- [ ] B1 perception（分档注入、每档一次）
- [ ] B2 compact 工具 + 规则提示 + 阈值兜底 + 连续上限
- [ ] B3 pins 幸存契约 + 折叠后重注入
- [ ] B4 spill 外溢 + `fetch_blob`
- [ ] B5 handoff + `onHandoff` 回调
- [ ] B6 memory 工具（memory_20250818 形状）+ 路径防穿越
- [ ] B7 approval Policy 管线（deny→ask→allow、fail-closed、HMAC）
- [ ] B8 budget 上限 + `budget_usage` 事件
- [ ] B9 `@reins/store-sqlite` 与 `@reins/store-pg`（投放工具用 pg，dogfood 直接落 pg；两者共跑 `@reins/core/testing` 套件）
- [ ] B10 `@reins/adapter-tanstack-ai`
- [ ] B11 投放工具接入（Boss 参与：选一条真实长任务流程）

## M2 数字（目标 2 周）

- [ ] E1 eval 运行器与指标
- [ ] E2 首批 fixture（投放工具脱敏）
- [ ] E3 三组对照跑数 → 决定默认开关
- [ ] E4 文档、CHANGELOG、0.1 发布准备（远程仓库与 npm 组织在此之前建）
