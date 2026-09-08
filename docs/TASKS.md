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
- [x] T7 `@reins/lowering-pi`：事件 → pi-ai Message → 请求；流式响应 → 事件；capabilities；有损矩阵落地 —— 验收：Anthropic 与 OpenAI Responses 各跑通一次带工具调用与 thinking 回放的往返（2026-09-08 完成：core 增加 `Lowering` 接口、`EventDraft`、有损矩阵类型；`PiAiLowering` 只从 pi-ai `api/*` 与 `providers/*.models` 导入；system_note 经 `onPayload` 改写为 Anthropic 中途 system 并按官方规则归位、OpenAI 落 developer；用假 fetch 断言两家请求体（thinking 签名 / reasoning item 回放、tool 配对、system 归位、store:false）与假 SSE 译回草稿，13 用例全绿。真实联网往返已通过 Boss 提供的聚合网关跑通两家各两轮（回放 thinking / reasoning、工具结果、中途 system_note 全部 exact），见 `spikes/gateway-check/README.md`）
- [x] T8 有损声明测试：每种事件在两家 API 的落点有断言，禁止静默丢弃 —— 验收：矩阵测试全绿（2026-09-08 完成：`LOSS_MATRIX` 覆盖 15 种 core 事件 + ext.* × 两家 API；`loss-matrix.test.ts` 用 19 个变体 × 4 个模型目标逐条断言实际落点必在声明内，并反向检查矩阵无死条目，77 用例全绿）

### 阶段 4：循环与运行状态

- [x] T9 `runLoop` 异步生成器 + Socket 五个钩子 + RunResult 四态 —— 验收：一个带工具的 agent 跑三轮并结束；日志可完整回放（2026-09-08 完成：`packages/core/src/loop/`，539 行生成器 + Socket / Tool / RunResult 类型 + `defineTool`；`@reins/core/testing` 新增 `ScriptedLowering` 剧本式假模型。28 用例全绿：三轮带工具结束、每轮模型看到的恰是日志前缀的投影、整段日志可重放、五钩子调用顺序、block / rewrite / defer、审批暂停→再跑不重复请求→批准后续跑→拒绝走 isError、客户端工具暂停回填、工具三类失败不崩、error / aborted / maxTurns / handoff、确定性双跑逐字相同、阈值 compaction 先入日志。续跑统一为"先补齐无结果的 tool_call"，T10 只剩序列化签名与 decisions 参数）
- [x] T10 RunState 序列化 / 恢复 + 审批暂停（`paused`）跨进程续跑 —— 验收：进程 A 暂停、进程 B 恢复的测试（2026-09-08 完成：`loop/state.ts` 加 `pendingDigest`、HMAC-SHA256 签名、`validateResume` 八种拒绝码；`LoopConfig` 加 `resume` / `decisions` / `secret` / `allowConfigDrift`。`run-state.test.ts` 17 用例：进程 A 暂停→状态 JSON 不到 400 字节→进程 B 新实例批准恢复到 done / 拒绝走 isError / 无结论再暂停；篡改 pending 或 lastSeq、换密钥、去签名、换会话、换工具集或系统提示、空日志、pending 被回填、decisions 指错、形状不对共 10 条拒绝路径全部在写日志前抛错。全仓 212 用例绿）
- [x] T11 fork：任意 seq 分叉出新会话 —— 验收：分叉后两条会话独立演进（2026-09-08 完成：`loop/fork.ts` 的 `forkSession` 包一层 `EventLog.fork`（缺省生成新 id）；3 用例：轮边界分叉后两线各自追加、事件 id 保留、seq 各自续编、分叉线看不到主线后来的话；切在 tool_call 与 tool_result 之间时新会话把该调用当 pending 重新执行、原会话一条不变；越界与目标非空由存储层拒绝。全仓 215 用例绿，阶段 4 收口）

### 阶段 5：服务端与前端

- [x] T12 `@reins/server` `createAgentHandler`：Web 标准 handler、SSE、`lastSeq` 重连补发 —— 验收：Node 与 Cloudflare Workers（miniflare）各跑通（2026-09-08 完成：`packages/server`，handler / runs / sse 三个源文件约 450 行。POST 起 run 并实时推每条刚 append 的事件，SSE `id:` = seq，结束给 `result` 帧；GET 带 `lastSeq` 或 `Last-Event-ID` 从 EventLog 补发，撞上正在跑的 run 则接着实时推；同会话单 run（409）；发起者断开缺省不中止；resume / decisions 开流前预校验给 409；编码器可插，缺省推原始事件，AG-UI 留给 T13。15 用例：纯 Web Request 调用 12 项（流式顺序与日志逐字一致、补发去重、正在跑时重连不重不漏、409、continue / abort、审批暂停 → 回传 state 批准 / 拒绝、篡改 / 指错 / 换会话 409 且一条日志不写、400 / 405、principal 钩子）、真实 node:http 经 TCP 边跑边收 1 项、miniflare / workerd 1 项（esbuild 打包产物零 `node:` 引用、waitUntil 挂上）。全仓 230 用例绿）
- [x] T13 `@reins/ui-agui` 事件映射 —— 验收：映射表测试；一个最小 HTML 页面消费流（2026-09-08 完成：`packages/ui-agui`，`mapEvent` 纯映射 + `AGUI_MAPPING` 映射表 + `createAguiEncoder` 有状态编码器（流式增量与随后的完整事件接成同一条消息）+ `aguiEncoding()` 直接塞给 server 的 `encode`。运行时零依赖，31 用例全部用 `@ag-ui/core@0.0.59` 官方 zod schema 逐条校验产出：15 种 core 事件 + ext.* 的映射表逐条核对、无死条目、图片有损声明、空正文不发空 delta、tool_args 增量丢弃、paused → interrupt outcome、error → RUN_ERROR、接 server 整条流首尾与 seq 挂帧。server 的 `encode` 改为按流工厂（编码器有状态，多流并发不能共享）；修了 lastSeq 超末尾时实时事件被误当已补发的问题。demo：`packages/ui-agui/demo/`（`serve.mjs` + `index.html`，无依赖），经网关用 Claude Opus 5 实跑：流式思考、查天气、上线请求暂停、批准后续跑到 done，全部走 AG-UI 事件；无密钥时剧本模式离线可跑。全仓 262 用例绿）
- [x] T14 示例应用 `examples/minimal`：五分钟体验代码原样可跑 —— 验收：PRD §5.1 代码块复制即用（2026-09-08 完成：新总包 `reins`（`createAgent` + 原样再导出 core / server / ui-agui；`agent.handler` 缺省 AG-UI 编码，`agent.run()` 不经 HTTP 直接跑）；lowering-pi 加 `anthropic()` / `openai()` 工厂返回 `BoundModel`（apiKey 必填、可带 baseUrl 走网关）；core 加 `Stores` 与 `memoryStore()`；server 加 `@reins/server/node` 子路径的 `nodeListener`（node:http 适配，主入口仍纯 Web 标准）；ui-agui 导出 `demo/index.html`。`examples/minimal/agent.ts` 即 PRD §5.1 代码（PRD 同步改为显式 apiKey），`server.ts` 用 Node 22 类型剥离直接 `node server.ts` 跑。经网关用 Claude Opus 5 实跑：页面、流式思考、工具、补发全通；无密钥明确报错退出。新增 7 用例（createAgent 三条、工厂三条、memoryStore 一条），全仓 269 用例绿）

### 阶段 6：M0 收口

- [x] T15 回放演示：从事件日志重放一次完整会话并展示 —— 验收：Boss 能看到"发生过什么"的时间线（2026-09-08 完成：core 新增 `replayTurns(timeline, { budget })`，只凭日志重算每一轮模型看到的事件（投影是纯函数，与 ScriptedLowering 记录的实际请求逐字相同，4 用例）；`examples/minimal/record.ts` 经网关用 claude-opus-5 录下真实会话 `recordings/weather-deploy.jsonl`（17 条事件：问天气 → 思考 → 调工具 → 答 → 要上线 → 审批暂停 → 批准续跑 → 答），`replay.ts` 不需要 key 离线回放：逐行 fail-closed 读取 → 整批灌入新日志校验自洽 → 逐轮重算投影与有损落点，终端打时间线并生成零依赖静态页面 `recordings/replay.html`（每轮卡片点开高亮"模型看到 / 看不到"，点事件看完整载荷，按真实时间比例重放）。全仓 273 用例绿）
- [x] T16 M0 复盘：更新技术方案与 DECISIONS —— 验收：文档与代码一致（2026-09-08 完成。逐节对照技术方案与代码，发现并修复一处硬约束违反：方案与 §14 都写"schema 升级只读时 upcast"，但循环、server 补发、resume 预校验读日志时都没过注册表，旧版本事件与未登记的 ext.* 会被静默透传。修法：core store 层新增 `readTimeline` / `readEvents`（逐条 `registry.read`），循环起步、每轮、暂停对账，server 补发与预校验全部改经它读；run 起步先整条过一遍，读不出来就在写任何东西之前抛 `SchemaError`。6 个新用例（v1 → v2 升级、原件不改写、ext.* 未登记拒绝 / 登记后可读、未来版本拒绝、循环端到端两条）。文档回填：§3 包表去重（ui-agui 重复行、不存在的 store-memory 包、store-postgres → store-pg 并提前到 M1）、§4 写明升级发生在哪、§7 行数 578、§8 加回放段、§12 补发经注册表、§16 M0 完成情况（Bun 未实测如实写明）、§17 勾掉 AG-UI 自定义事件约定。全仓 279 用例绿。M0 收口）

## M1 脑子 v1（目标 3 周）

- [x] B1 perception（分档注入、每档一次）—— 验收：注入内容按档位离散化；遵守技术方案 §9.1 的五条 prompt cache 约束（只追加在末尾、旧说明不删不隐藏、系统提示与工具表稳定）；用 `budget_usage.tokens.cacheRead` 对比注入前后，命中占比不下降，并关闭 §17 对应待核实项（2026-09-08 完成：`packages/brain/src/perception/`，`perception(options): Socket`，beforeModel 里算读数 → 渲染 → 与模型当前可见的最后一条感知说明逐字比对 → 不同才 emit 一条 `system_note(kind=perception, meta.reading)`，永不返回补丁。读数七项全部分档（上下文使用率、阈值兜底触发点、未折叠轮数、整理次数、会话累计 token、外溢结果数、配置 limits 时最紧一维余量）。core：投影链删掉 `perception` 插槽（感知是 Socket 不是策略）、`TurnContext.budget.targetTokens`、`SystemNotePayload.meta` 可选字段。13 个 brain 用例：首轮注入在 user 之后模型输出之前、三轮系统提示与工具表逐字相同、同档不重复、变档只追加旧的留原位、余量跨档、折叠后重注入、自定义文案判重、非法边界拒绝。**顺带发现并修了降级层的问题**：感知说明殿后时 pi-ai 打在它上面的 Anthropic 缓存断点会在改写成 system 时丢失，官方规则是断点之后一律不缓存；做成 `midSystemCacheBreakpoint`，缺省 `automatic`（去块级断点、顶层补自动缓存）。实测经网关 claude-opus-5：不注入 91.8%~93.3%，默认档位 92.9%、每轮变档 93.9%，不降；`previous-user` 低 3~6 个点，留在 system 消息上崩到 18.6%；gpt-5.5 基线 16.5% → 32.9% / 38.2%，亦不降。§17 对应项关闭。全仓 299 用例绿）
- [x] B2 compact 工具 + 规则提示 + 阈值兜底 + 连续上限（2026-09-08 完成：`packages/brain/src/compact/`，`compact(options): Socket`。core 新增 **Socket 静态贡献** `tools` / `systemPrompt`（循环起步并入、整个 run 不变、计入 configHash、续跑补齐 pending 时在场），beforeModel 补丁改顺序合并。工具 `compact({ summary, keep, keepRecentTurns? })`：afterTool 按视图算出 `compaction(decidedBy=model)` 经 emit 入日志（tool_call → compaction → 回执），切点与投影裁剪同口径（模型轮边界、发起调用所在轮永不折、seq 封闭），pin / 旧摘要已保留项 / **最近一条用户消息**进 pinsKept 幸存。阈值兜底复用 core `budgetTruncate`；连续上限缺省 3（模型 + 阈值合计，按轮分段计数，收尾轮不拦）→ `pause(budget)`。16 个 brain 用例 + core 3 个（静态贡献、pending 在场、补丁合并），全仓 319 用例绿。真模型核实 `spikes/b2-compact-live`（claude-opus-5 经网关，5 种情形 26 次请求全 200）：模型入参全部合法；整理后请求形状 `user(摘要) → user(幸存用户消息) → assistant(thinking+tool_use) → user(回执)` 被接受；阈值兜底摘要作首条 user 文本也被接受；整理后模型记住 keep 里的总重并接着干活。**实测抓到并修了一个缺陷**：模型把"先整理，然后做 X"这条指令一起折进摘要、整理完反问 X 是什么 → 最近一条用户消息缺省幸存。附带发现两项待核实写入技术方案 §17：感知使用率按视图粗估偏低（B8 校准）、网关在 system 收尾时疑补占位消息）
- [x] B3 pins 幸存契约 + 折叠后重注入（2026-09-08 完成：`packages/brain/src/pins/`，`pins(options): Socket`。宿主 `PinSpec[]`（字符串 / `{name,text}` / `{name,extract(ctx)}`）在 beforeModel 与视图里可见的同名 pin 逐字比对、不同才追加到末尾并 `supersedes` 旧的；模型 `pin({ text, replaces? })` 工具走静态贡献 + `PIN_RULES`，afterTool 里 emit `system_note(kind=pin, actor=model, parentId=tool_call)`，同文不重复，`replaces` 只能指模型自己钉的。core 新增 `SystemNotePayload.supersedes?`，fold / truncate / compact 规划三处幸存判定一致排除被取代者。幸存与重注入沿用 T6 投影链。13 个 brain 用例（首轮注入位置与三轮提示/工具表稳定、多 run 不重复、命名 pin 换文字取代、抽取式 pin 变化取代 / undefined 不动、工具日志顺序与下一轮可见、replaces 四种结果、入参校验、pins × compact 端到端 pinsKept 与视图顺序、关掉自动幸存后的重注入兜底、构造期校验与纯函数）+ core 4 个（折叠 / 取代者自身被折 / 未折叠不隐藏 / 裁剪）。全仓 336 用例绿）
- [x] B4 spill 外溢 + `fetch_blob`（2026-09-08 完成：`packages/brain/src/spill/`，`spill(options): Socket`。afterTool 里把结果文本超过上限（`Tool.resultPolicy.maxTokens` 优先，模块缺省 8k）的全文原样写 BlobStore，模型看到 `[说明 + 首尾各 N 行预览]`，`tool_result.spilled = { blobId, summary }`，日志仍只一条 tool_result；`overflow: "truncate"` 的工具不存 blob 并明说不可恢复；没有 BlobStore 则原样通过并告警一次。`fetch_blob({ id, start?, end? })` 按字符偏移分段取回、单次按同一上限裁并告知续读位置，只读本会话的文本类 blob，越权当不存在，自身结果不再外溢。图片片段不度量原样保留。23 用例：静态贡献稳定、小结果一字不改、大结果全文进 blob / 预览形状 / 下一轮可见、错误结果保 isError、图片跟随、fetch 五种边界与四种拒绝、truncate 零 put、按工具覆盖上限、无 BlobStore 告警一次、perception 数得到外溢、纯函数。全仓 359 用例绿）
- [ ] B5 handoff + `onHandoff` 回调
- [ ] B6 memory 工具（memory_20250818 形状）+ 路径防穿越
- [ ] B7 approval Policy 管线（deny→ask→allow、fail-closed、HMAC）
- [ ] B8 budget 上限 + `budget_usage` 事件（附带：perception 的上下文使用率改用上一请求真实用量校准，见技术方案 §17 B2 实测发现）
- [ ] B9 `@reins/store-sqlite` 与 `@reins/store-pg`（投放工具用 pg，dogfood 直接落 pg；两者共跑 `@reins/core/testing` 套件）
- [ ] B10 `@reins/adapter-tanstack-ai`
- [ ] B11 投放工具接入（Boss 参与：选一条真实长任务流程）

## M2 数字（目标 2 周）

- [ ] E1 eval 运行器与指标
- [ ] E2 首批 fixture（投放工具脱敏）
- [ ] E3 三组对照跑数 → 决定默认开关
- [ ] E4 文档、CHANGELOG、0.1 发布准备（远程仓库与 npm 组织在此之前建）
