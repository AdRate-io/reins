# Cursor 审查报告：24 个未推送 commit 全面审查

> **日期**：2026-09-15  
> **审查范围**：`origin/main..HEAD`（24 commits，238 文件，+22216 / −641 行）  
> **审查方式**：5 路子代理并行 + 主代理核实交叉验证  
> **当前状态**：1224 个用例全绿，69 个测试文件

---

## 审查组织

| 子代理 | 维度 | 关注点 |
|--------|------|--------|
| [Bugbot 全面代码审查](1a32ab00-8309-4e40-afb4-9dcb8253df3d) | 代码质量与 bug 检测 | 逻辑错误、竞态、错误处理、类型安全、跨包接口一致性 |
| [安全审查](0a8f333b-99b2-4632-bb59-cdcd29b76ded) | 安全漏洞扫描 | 审批绕过、信任边界、输入校验、认证鉴权、信息泄露、凭证处理 |
| [架构合规审查](1e34ae2c-dd69-48a6-a9df-7a1448285739) | 宪法与硬约束合规 | 零 Node 依赖、EventLog 只 append、依赖方向、fail-closed、文案语言、schemaVersion |
| [lowering-fetch 深度审查](bd6ddfab-f6af-4881-84e2-5ceb35900501) | 最大新增模块深度审查 | 三线完整性、IR 层、流解析、有损矩阵、凭证安全、测试覆盖 |
| [文档与代码一致性审查](e231a7d2-0cf7-4653-bfc2-faff26f7ead4) | 文档同步 | 模块盘点文件清单、全景图、DECISIONS、TASKS、技术方案、踩坑记录、changeset |

---

## 24 个 Commit 总览

| # | Hash | 类型 | 主题 |
|---|------|------|------|
| 24 | `19e9820` | feat | D1 工具懒发现——lazyTools 模块、tool_find、eval fixture 与缓存 spike |
| 23 | `5955d45` | feat | D2 旁路观测钩子 onEvent——HTTP 路径的 run 逐条事件可接宿主日志/追踪 |
| 22 | `bfb49b3` | feat | D3 批准有效期 approval({ ttlMs })——到得太晚的批准按拒绝处理并留痕 |
| 21 | `db12074` | docs | D4 开工前置判断入任务板 |
| 20 | `f816471` | docs | D4 设计定形 |
| 19 | `49d5dea` | feat | D4 跨进程 run 登记——RunLease 接口、leasedRunRegistry、pg 租约表 |
| 18 | `00893aa` | docs | D5 脱敏配方入根 README |
| 17 | `5ca59ed` | docs | lowering-fetch 立项 |
| 16 | `ffe3393` | docs | CF AI Gateway 靶子已就绪 |
| 15 | `3e05249` | docs | Cloudflare AI Gateway 的用法与坑 |
| 14 | `57cf6c3` | spike | F0 靶子体检——CF AI Gateway 透传路径 43/43 忠实 |
| 13 | `f3e3427` | feat | F1 零依赖降级层骨架 + Chat Completions 线真模型跑通 |
| 12 | `3d43031` | feat | F2 Anthropic Messages 线 + 经 CF 网关真模型双臂 9/9 |
| 11 | `b77b713` | feat | F3 OpenAI Responses 线 + 经 CF 网关真模型双臂 9/9 |
| 10 | `c16e3ea` | docs | F4 收口——workerd 最严档三线真模型 15/15 |
| 9 | `a082a0c` | feat | L1 lazy-tools 原生路径——Anthropic defer_loading + tool_reference |
| 8 | `63c8dfd` | spike | L1 补计费三臂——defer_loading 取回之前不计费 |
| 7 | `0f31d1e` | spike | L1 P9 计费重做——盐落在断点内，六臂 6/6 |
| 6 | `894594d` | spike | 四环境验证——Bun / Deno / Vercel Edge |
| 5 | `60887e4` | spike | 四环境验证补真 Vercel Edge 生产部署——7/7 |
| 4 | `14345eb` | refactor | 运行时告警与构造期错误文案全面英文化（519 处） |
| 3 | `ade208e` | docs | JSDoc 保持中文，撤下待拍板项 |
| 2 | `41db9c1` | feat | MCP 接网关型服务器——auth 口子与审批红线 |
| 1 | `071f53b` | docs | TikTok MCP 实测反馈归档 |

---

## 综合结论

### 🟢 无阻塞合并项

五路审查**均未发现需要阻塞合并的严重缺陷**。核心路径（runLoop、server、lowering-fetch、RunLease）逻辑正确，安全默认值 fail-closed，架构约束全部合规。

### 发现分级汇总

| 级别 | 数量 | 分类 |
|------|------|------|
| 🔴 严重（阻塞） | 0 | — |
| 🟡 高（跨包一致性） | 2 | TanStack 路径两处与 runLoop 行为分叉 |
| 🟠 中（加固/运维） | 4 | onEvent 超时风险、SSE 错误脱敏、createAgent 租约调参、lowering-fetch 边界加固 |
| 🔵 低 / 建议 | 5 | 文档偏差、eval 脚本文案、API 面设计偏好 |
| 📄 文档漂移 | 4 | 文件清单幽灵条目、测试计数过时、ASCII 模块数、用例总数 |

---

## 🟡 高优先级发现

### H1. TanStack 适配器：审批续跑不复检 `approval.ttlMs`

**来源**：Bugbot 审查 + 安全审查交叉确认

**现象**：runLoop 路径上，过期审批会在 `beforeTool` 走 `{ block }` + `approval_decision(approved=false, by="approval.expired")`。但 TanStack 适配器的审批续跑走 `onInterruptResolution` → `toolResume: "continue"` 路径，`beforeTools` 不会再次执行，`onBeforeToolCall` 对 `kind: "await"` 直接放行。

**后果**：在 TanStack 路径上，即使用户很晚才点「批准」，`approval({ ttlMs })` 也不会在工具执行前再次校验。

**涉及文件**：
- `packages/adapter-tanstack-ai/src/middleware.ts`（879–886 行）
- `packages/brain/src/approval/approval.ts`（347–370 行）

**测试缺口**：`middleware.test.ts` 有审批中断/批准/拒绝用例，但**无** `ttlMs` + 延迟 resume 用例。

**建议**：在 resolution 路径显式调用 TTL 校验（复用 `findExpiredApproval`），或在 DECISIONS 中明确「TanStack 路径 TTL 不生效」及其安全影响。

---

### H2. TanStack 适配器：不支持 `BeforeModelPatch.deferredTools`

**来源**：Bugbot 审查

**现象**：runLoop 会把 `patch.deferredTools` 转成 `ToolSpec.deferLoading`，但 TanStack `beforeModel` 只处理 `events` / `tools` / `systemPrompt`，不读 `deferredTools`，且默认 `capabilities.deferredTools: false`。

**后果**：`lazyTools()` 在 TanStack 上**永远走过滤路径**，拿不到 Anthropic `defer_loading` + 缓存前缀优化。

**涉及文件**：
- `packages/adapter-tanstack-ai/src/middleware.ts`（490–498 行）
- `packages/core/src/loop/run-loop.ts`（346–375 行）

**建议**：文档明确「L1 原生路径仅 runLoop + lowering-fetch」；或在 middleware 中要么拒绝 `deferredTools: true`，要么实现等价 wiring。

---

## 🟠 中优先级发现

### M1. `onEvent` 永久挂起导致会话长期 409

**来源**：Bugbot 审查

`handler.ts` 272–274 行的 `finally { await chain }` 意味着若 `onEvent` 某次调用永不 resolve，run 不会结束，`RunRegistry` 名额不释放。设计如此（保证 `waitUntil` 覆盖观测收尾），但缺少超时/可配置 `AbortSignal` 的文档与运维说明。

**建议**：在 `HandlerOptions` 文档中强调；可选增加 `onEventTimeoutMs`。

### M2. SSE 200 流内错误可能透出厂商响应 body

**来源**：安全审查

`HttpError.message` 含厂商响应 body 全文，若经 `core.error` 事件进入 SSE 推送，面向不可信客户端时可能含内部字段名、配额细节等。

**建议**：面向公网时应在网关或自定义 `encode` / `onEvent` 层截断或映射 provider 错误 body。

### M3. `createAgent` 自动租约未暴露 `ttlMs` / `owner` 调参入口

**来源**：Bugbot 审查

多实例部署只能使用默认 `ttlMs: 30_000` 和随机 `owner`，除非手动传 `handler.runs`。

**建议**：支持 `handler.leaseTtlMs` / `handler.leaseOwner`，或在文档中写明需自建 `leasedRunRegistry(...)`。

### M4. lowering-fetch 三处边界加固建议

**来源**：lowering-fetch 深度审查

1. `response.body === null` 无单测（`lowering.ts` 127–132 行）
2. Anthropic 连续两条 mid system 未实测（可能厂商禁止相邻 system）
3. `orderLandings` 未知 `eventId` 用 `?? 0` 静默兜底，开发态应 `warn`

---

## 🔵 低优先级 / 建议

### L1. eval / spike 脚本中文 `throw`

`examples/eval/fixtures/tool-discovery/catalog.ts`、`spikes/d1-lazy-tools-cache/measure.ts` 等有中文 throw。非 npm 包运行时，不影响宿主/模型，但若希望「凡 throw 均英文」一以贯之，可后续统一。

### L2. lowering-fetch 公开 API 面比 lowering-pi 宽

导出 `AnthropicRequestBody`、`ChatRequestBody`、`ResponsesRequestBody` 等手写 wire 类型，用于调试/高级宿主。模块盘点已写明，不构成 SDK 泄漏，属 API 设计偏好。

### L3. lowering-pi 与 lowering-fetch 的 `deferredTools` 能力位不一致

lowering-fetch Anthropic 默认 `true`，lowering-pi 恒 `false`。符合 DECISIONS，但迁移时易误判。建议在 lazy-tools README 写得更醒目。

### L4. 审批 `rewrite` 幂等性

批准只绑定 `tool_call` 入参摘要，不绑定 `beforeTool` 改写后的执行入参。若 rewrite 非幂等，「批的是 A、跑的是 B」可能成立。建议保持 approval 在 sockets 末位 + rewrite 幂等。

### L5. 网关型 MCP 工具审批规则

`gateway-tool.recipe.test.ts` 文档化：`tool_execute` 类工具须按入参内操作名写规则，否则按工具名的 deny/allow 失效。属集成配置风险。

---

## 📄 文档漂移

| # | 位置 | 偏差 | 建议 |
|---|------|------|------|
| D1 | `docs/模块盘点/brain.md` | 引用 `no-node-builtins.test.ts`，文件系统中**不存在** | 删除条目或恢复文件 |
| D2 | `docs/模块盘点/lowering-fetch.md` | 测试数写 **369**，实际 **392** | 更新或改为「14 个 `*.test.ts`」 |
| D3 | `docs/系统全景图.md` §2 ASCII | 写「九个 Socket」，实际十个（含 lazy-tools） | 改为「十个」 |
| D4 | `docs/TASKS.md` L1 行 + `docs/技术方案.md` §9.10 | 用例数写 **1218**，实际 **1224** | 更新为 1224 |

---

## 架构合规矩阵（9 项硬约束）

| # | 约束 | 结论 | 说明 |
|---|------|------|------|
| 1 | core / brain 主入口零 Node 依赖 | ✅ 合规 | `node:*` 仅在 `/node` 子路径；lowering-fetch 源码无 `node:*` |
| 2 | EventLog 只 append | ✅ 合规 | 变更仅英文化文案，无 UPDATE/DELETE 事件日志 |
| 3 | lowering-fetch 依赖方向 | ✅ 合规 | 唯一依赖 `@reinsjs/core` |
| 4 | 降级层不泄漏厂商类型 | ✅ 合规 | 导出自研 wire 类型，无 SDK 依赖 |
| 5 | fail-closed 安全默认值 | ✅ 合规 | TTL 过期 → block、租约失败 → 抛错、auth+Authorization 互斥构造期 throw |
| 6 | 运行时英文 / 注释中文 | ✅ 合规 | 库路径无中文运行时文案；eval/spike 有中文 throw（观察项） |
| 7 | schemaVersion | ✅ 合规 | 未新增 `core.*` 事件 type；`tool_reference` 为 ContentPart |
| 8 | configHash 共用 | ✅ 合规 | runLoop / server / TanStack 三处共用 `resolveSocketContributions` |
| 9 | 测试覆盖 | ✅ 合规 | 每个新功能模块均有对应测试文件 |

---

## 安全审查矩阵

| 领域 | 风险评级 | 一句话 |
|------|----------|--------|
| 审批绕过 | 低（配置得当） | 双层白名单 + pending 校验 + TTL block；rewrite 幂等+网关规则为宿主责任 |
| 信任边界 | 低 | 中心化 trust / untrusted 转义；skill 提权路径有构造期防护 |
| 输入校验 | 低 | sessionId 字符集、事件白名单、SQL 表名白名单到位 |
| 认证鉴权 | 高（若缺省部署） | **未设 `authorizeSession` / `secret` 时 sessionId ≈ 全权**；多租户必配 |
| 信息泄露 | 低 | blob 引用授权 + 统一「不存在」文案 |
| RunLease | 低 | PG 原子 acquire + seq_conflict 兜底 |
| lowering-fetch 凭证 | 低 | key 不进 payload；`auth:none` 文档清晰 |
| SSE 错误 | 中 | 200 流内 error / core.error 可能带上游响应 body |

---

## 各模块审查摘要

| 模块 | 逻辑/边界 | 并发/异步 | 错误处理 | 类型安全 | 测试 |
|------|----------|----------|---------|---------|------|
| **D1 lazy-tools** | 时间线重建、compact 折出视图、双路径 ✅ | WeakMap 按 turn 隔离 ✅ | 缺 lazy / 同名告警一次 ✅ | parseToolFindInput 严格 ✅ | 591 行专测 ✅ |
| **D2 onEvent** | 先 yield 再 hook；补发不调 ✅ | 链式串行、不阻塞 SSE ✅ | 一次 warn ✅ | 类型清晰 ✅ | handler.test.ts 专章 ✅ |
| **D3 approval TTL** | runLoop 正确 ✅ | N/A | fail-closed ✅ | ttlMs 构造校验 ✅ | **TanStack 路径缺** ⚠️ |
| **D4 RunLease** | PG 单语句 acquire/renew/release ✅ | 并发 create 有测 ✅ | renew 失败不 abort ✅ | 接口一致 ✅ | conformance + cross ✅ |
| **F1-F4 lowering-fetch** | 三线矩阵完整 ✅ | fetch 超时/abort 分离 ✅ | HttpError 对齐 core 重试 ✅ | 严格 TS ✅ | 14 个测试文件 ✅ |
| **L1 deferred-tools** | core 接线 + anthropic encoder ✅ | N/A | 未绑定引用展开 ✅ | ToolReferencePart ✅ | core + anthropic 专测 ✅ |
| **MCP auth** | 互斥校验 ✅ | 跨 run 复连 + 401 刷新 ✅ | 构造期 fail-fast ✅ | 清晰 ✅ | http.test.ts ✅ |
| **i18n 英文化** | 文案变更 ✅ | N/A | N/A | N/A | 现有用例断言英文 ✅ |

---

## lowering-fetch 专项评价

**整体评级：生产可用、维护友好，质量明显高于「首版 adapter」常见水平。**

### 亮点

1. **三线对称架构**：IR 与协议 encoder/decoder 分离干净，`eventsToIr` → 各线 `encode*Request` → `orderLandings` 共用管线
2. **有损矩阵工程化**：变体穷举 + 死条目检测 + 与 pi 表对照，改 landing 很难「静默漏声明」
3. **Anthropic 复杂度可控**：S1 归位、B1 缓存三档、L1 六类场景有专测，注释与 spike 引用完整
4. **零 `node:*`、单依赖 core**：edge 友好；三条 runLoop E2E 集成测试证明可作为 `createAgent` 降级层
5. **凭证安全**：key 不进 payload，`auth: "none"` 不调 `apiKey`、不加 Authorization

### 对照 CLAUDE.md 技术要点

| 要点 | 实现一致性 |
|------|----------|
| Chat 线四处有损 | ✅ 矩阵与实现一致 |
| DeepSeek + tools 必带 `reasoning_content` | ✅ 方言开时无 thinking 也写 `""` |
| Anthropic 中途 system 退 user | ✅ `flushNotes` + `framedSystemNote` |
| Anthropic thinking 签名回放 | ✅ signature / redacted / dropped |
| Responses reasoning 判据 `encrypted_content` | ✅ `reasoningItemOf` + `include` |
| Responses `store:false` / 剥 `previous_response_id` | ✅ |
| HttpError 文案 `"<status> <body>"` | ✅ 附带 status / headers |
| `auth: "none"` 不加 Authorization | ✅ |

---

## 跨包接口一致性

| 能力 | runLoop + server | TanStack adapter | 一致？ |
|------|-----------------|------------------|--------|
| `decisions` 预校验（子 session 转发） | ✅ | ✅ | 一致 |
| `approval.ttlMs` | ✅ | ❌ 续跑不复检 | **不一致** |
| `BeforeModelPatch.deferredTools` | ✅ | ❌ 不支持 | **不一致** |
| `toolResultTrust` | ✅ 四处 | ✅ 已调 | 一致 |
| `resolveSocketContributions` / configHash | ✅ 共用 | ✅ 共用 | 一致 |
| `inputDraft` 事件白名单 | ✅ server + runLoop | N/A（TanStack 无 HTTP 入口） | 不适用 |

---

## 测试覆盖建议（按 ROI 排序）

1. **TanStack `approval({ ttlMs })` + 延迟 resume** → 应 block + `approval.expired`（对齐 runLoop 用例）
2. **TanStack `lazyTools()` 过滤路径** → 取回后第二轮工具表变化与 runLoop 一致性
3. **lowering-fetch `response.body === null`** → 补一条 fake Response 用例
4. **lowering-fetch 连续 Anthropic mid system** → spike 或单测验证厂商是否接受
5. **createAgent + pgStores 端到端** → 两实例 409 + TTL 过期接手

---

## 发布前检查清单建议

- [ ] 上述 4 处文档漂移修复
- [ ] H1（TanStack TTL）决策记录：修代码或文档声明 scope
- [ ] H2（TanStack deferredTools）决策记录：文档声明「原生路径 = runLoop + lowering-fetch + Anthropic」
- [ ] `pnpm check` 全绿（当前已绿）
- [ ] `pnpm check:dist` 构建产物自检
- [ ] 真模型 spike 冒烟（F0～F3 各臂、L1 端到端）
- [ ] changeset version + 版本号确认

---

## 审查签名

- **Bugbot**：覆盖全 diff 的代码质量审查，发现 TanStack 路径两处跨包不一致
- **安全审查**：确认 2026-09-09 级审批绕过未回归，主要风险在部署配置层
- **架构合规审查**：9 项硬约束全部合规，无阻塞项
- **lowering-fetch 深度审查**：三线完整、矩阵对齐、凭证安全，生产可用
- **文档一致性审查**：规格与决策高度一致，4 处文档漂移可快速对齐

**总体评价**：24 个 commit 覆盖 D1～D5、F0～F4、L1、MCP auth、i18n、四环境验证，代码质量与工程规范保持一致水准。核心路径无逻辑缺陷，安全防线完整。最值得关注的是 TanStack 适配器路径与 runLoop 的两处行为分叉（H1/H2），需在发布前做出决策（修代码或文档声明 scope）。
