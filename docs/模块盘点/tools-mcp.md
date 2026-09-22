# @reinsjs/tools-mcp 模块盘点

> 依据 2026-09-10 的 `packages/tools-mcp/src/` 源码写成（任务 P1）。规格在 `docs/技术方案.md` §10，决策在 `docs/DECISIONS.md` 2026-09-10 的 MCP 三行。

## 架构概览

把一台 MCP 服务器接成 reins 的**一个 Socket**。形状刻意最小：只用 Socket 的静态贡献 `tools`（异步函数），一个钩子都不挂 —— run 起步 `tools/list` 一次翻成 `Tool[]`，`execute` 就是 `tools/call`。其余全部交给既有机制：spill 在 afterTool 外溢大结果、approval 在 beforeTool 按 risk 问人、budget 计数、循环把抛错记成 `tool_result(isError)`。服务器不需要知道 reins（P3）。

依赖只有两个：`@reinsjs/core`（workspace）与官方 `@modelcontextprotocol/client@2.0.0`（pin 精确版本）。MCP SDK 的类型**不出本包**：对外只有 reins 的 `Tool` / `Socket` 和本包几个纯数据形状（`McpToolInfo`、`McpToolAnnotations`、`McpTransport`）。

两个入口：
- `@reinsjs/tools-mcp`（主入口）：`mcpTools()`、`httpTransport()`（Streamable HTTP）与翻译纯函数。零 `node:*`；官方 client 主入口实测也零 `node:*`（靠 `_shims` 条件导出在 workerd 选 cf-worker 校验器、Node 选 Ajv）。最严档 workerd（2023 compat date、无 `nodejs_compat`）实测 list + call 通过。
- `@reinsjs/tools-mcp/node`：`stdioTransport()`，起子进程。只有这里牵进 `node:process` / `node:stream` / `cross-spawn`。

```
mcpTools({ transport })                    ── Socket { name: "mcp:<label>", tools: async () => Tool[], close() }
   │ tools()（每次 run 起步）                      │
   ▼                                              ▼ Tool.execute(args, ctx)
McpConnection.listTools() ──▶ toToolInfo ──▶ toTool（modelToolName / riskOf）      McpConnection.callTool() ──▶ toContentParts
   │ ensure()：懒连、复用、断了下次需要时按配方重建一次
   ▼
transport.create() → MCP SDK Transport → Client.connect
```

## 文件清单

| 文件路径 | 职责 |
| --- | --- |
| `packages/tools-mcp/package.json` | `@reinsjs/tools-mcp`，exports `.` 与 `./node`；依赖 `@reinsjs/core` + `@modelcontextprotocol/client` 2.0.0（精确）；devDeps 官方 server、zod、brain（测试用） |
| `packages/tools-mcp/tsup.config.ts` | 两个入口，`removeNodeProtocol: false`，dts 清 paths |
| `packages/tools-mcp/README.md` | 对外说明（英文）：用法、按 run 绑定、注解映射、连接生命周期、免重启原理与漂移三选一、网关型服务器审批配方、大而平工具表配方（只读 → `lazy` 进 lazy-tools 菜单、业务错误信封转 isError，2026-09-22）、上游实测 |
| `packages/tools-mcp/src/index.ts` | 主入口门面：`mcpTools`、`httpTransport`、翻译纯函数、公开类型 |
| `packages/tools-mcp/src/types.ts` | `McpToolInfo` / `McpToolAnnotations`（纯数据）、`McpTransport`（配方：`kind` / `label` / `create(): unknown`）、`McpAuth`（`token()` / `onUnauthorized?()`，结构兼容 SDK 的 `AuthProvider` 但不引用其类型）、`McpToolsOptions`、`McpToolsSocket`（Socket + `close()`）、`McpToolsError` |
| `packages/tools-mcp/src/mcp-tools.ts` | `mcpTools(options): McpToolsSocket`：`tools` 异步贡献（list → 翻译 → `override` → 去掉 `false`）；`optional` 决定 list 失败是抛还是空表 + 告警一次；`execute` = `callTool` + `toContentParts`，`isError` 直通 |
| `packages/tools-mcp/src/connection.ts` | `McpConnection`：`ensure()` 懒建 / 并发合流 / `onclose` 清引用 / 下次需要时重建；`listTools`（`cacheMode: "bypass"`，绕过 SDK 列表缓存）；`callTool`（timeout + signal）；`close`（建连进行中调用会等建连有结果再关，不然连接会被挂回来漏掉——2026-09-10 审查修） |
| `packages/tools-mcp/src/translate.ts` | 纯函数：`modelToolName`（前缀 + 非法字符改写 + 截 64）、`riskOf`（readOnly → low，destructive → high，其余 medium）、`toToolInfo`（声明 → 纯数据，形状不对抛错）、`toContentParts`（text / image 原样；audio、resource_link、二进制 resource → 说明文字；文本 resource 带 uri 头；空 content 用 structuredContent） |
| `packages/tools-mcp/src/http.ts` | `httpTransport({ url, headers?, auth?, fetch?, requestInit? })`：标签只留 origin + pathname（查询串常带 token）；`auth` 包一层交给 SDK 的 `authProvider`（我们的签名收 `MaybePromise`），与 `headers.Authorization` 互斥、构造期即拒 |
| `packages/tools-mcp/src/node.ts` | `stdioTransport({ command, args?, env?, cwd?, stderr? })`，`/node` 子路径 |
| `packages/tools-mcp/src/test-utils.ts` | 测试夹具：四个工具（echo 只读 / drop_table 破坏性 / flaky 按需 isError / big 大结果）的内存 McpServer，`transport.create()` 每次造新 linked pair，可 `down` 模拟服务器死掉 |
| `packages/tools-mcp/src/connection.test.ts` | `McpConnection.close` 边界：建连进行中 close 不漏连接、之后重建；建连失败时 close 不抛；空操作 |
| `packages/tools-mcp/src/translate.test.ts` | 纯函数用例：名字改写、风险档、声明解析、七种内容块翻译 |
| `packages/tools-mcp/src/mcp-tools.test.ts` | 端到端（内存传输 × runLoop）：list 翻译与懒连复用、prefix / override / 改名告警、isError 直通、服务器删工具后调用 → isError、服务器死掉 → isError 且回来后重建、连接断而服务器在 → 同 run 内重建、run 中 listChanged 不改本 run 表且下次 run 出说明、暂停中换表 → `config_mismatch` / `allowConfigDrift` 放行且出说明、× spill × approval 同装、起步连不上 fail-closed / optional |
| `packages/tools-mcp/src/readonly-lazy.recipe.test.ts` | 大而平工具表配方的可执行版本（与 README 逐字一致）：`override` 只留 `readOnlyHint` 工具并标 `lazy: true`、`withBusinessErrors` 把 `{code≠0}` 成功结果翻成 isError；用例 ① mcpTools 在前 + lazyTools 在后（菜单只列只读、首轮只有 tool_find、取回后可调、写工具是未知工具、trust=system）② 反面：顺序反了退化为全表下发 + 两处告警 ③ 纯函数边界 |
| `packages/tools-mcp/src/http.test.ts` | Streamable HTTP 走 `createMcpHandler().fetch`：list + call、鉴权头、标签、第二个客户端先后初始化 |
| `packages/tools-mcp/src/node.test.ts` | stdio：起 `test-fixtures/stdio-server.mjs` 子进程 list + call |
| `packages/tools-mcp/test-fixtures/stdio-server.mjs` | 测试用 stdio MCP 服务器（一个 echo 工具） |

## 核心流程

### 一、run 起步：静态贡献解析里 `tools/list`

1. `resolveSocketContributions`（core，P1 起 **async**）按注册顺序 `await` 每个 Socket 的 `tools`；本 Socket 的 `tools()` 调 `McpConnection.listTools()`。
2. `ensure()`：有活连接直接用；正在连就等同一个 Promise；没有（首次，或上次 `onclose` 清掉了）就 `transport.create()` + `Client.connect()`，失败抛 `McpToolsError`。
3. `client.listTools({}, { cacheMode: "bypass" })`：SDK 会翻完分页；bypass 缓存是因为每次 run 要的就是服务器此刻的表。
4. 每项 `toToolInfo` → `toTool`：名字 `modelToolName(name, prefix)`（改写过就 `warn` 一次）、`description ?? title ?? name`、`inputSchema` 原样、`risk = riskOf(annotations)`、high 时 `needsApproval: true`；再过 `override`。
5. 失败：`optional` 为 false（缺省）原样抛 → runLoop 在写任何日志前失败；true → 返回 `[]` 并告警一次，随后循环的 tools_bound 比对会把这些工具列为 Removed 告诉模型。

### 二、模型调用：`execute` → `tools/call`

1. `callTool(原名, args, { timeoutMs, signal: ctx.signal })`；连接断了 `ensure()` 会重建一次（服务器还在就成功，模型无感；服务器死了抛错）。
2. 结果 `toContentParts` + `isError === true` → `{ content, isError }`，循环按 `normalizeToolOutput` 原样入 `tool_result`。
3. 抛错（服务器已删该工具 `ProtocolError -32602`、`Not connected`、超时）由循环记成 `tool_result(isError, "工具执行失败：…")`，run 不崩。

### 三、工具表变化怎么被看见（core 侧，本包不做事）

服务器 `listChanged` 只影响下一次 run。下一次起步 list 到新表 → `resolveSocketContributions` 结果不同 → runLoop 的 `toolsBoundDrafts` 比对上一条 `core.tools_bound` 有增删 → 追加 `system_note(kind=host)` "Your available tools changed…"。暂停中的 run 续跑会因 configHash 变化被 `validateResume` 拒绝（`config_mismatch`），`allowConfigDrift` 放行后同样出说明。

## 核心设计决策

- **Socket 形态而非 ToolSource** — 与进程内工具走同一条路进循环，spill / approval / budget 自动生效；`mcpTools()` 就是普通 Socket，`createAgent({ sockets })` 放进去即可。
- **静态贡献异步化**（core 小改）— `tools/list` 是网络调用，同步解析不可能成立；改 `StaticContribution` 允许返回 Promise、`resolveSocketContributions` 变 async，三处调用点（循环、server 预校验、TanStack 适配器）都在异步上下文。各 Socket 仍**依次**解析而非并发：同名去重以先到者为准，顺序变 configHash 就变。
- **传输是"配方"不是"连接"** — `McpTransport.create()` 可重复调用，连接由 `mcpTools()` 懒建、跨 run 复用、断了下次需要时重建一次。SDK 的 `Transport` 类型对外按 `unknown`，MCP 类型不出本包。不做退避重试：一次调用失败就让模型看到 isError 自己定（宪法一）。
- **注解只定缺省** — spec 说注解是提示、不可信服务器的注解不能当权限依据。readOnly → low、destructive → high + 要审批、其余 medium 交给 approval 的策略；刻意不把"没写 destructiveHint"当破坏性（spec 缺省为 true），否则每个 MCP 工具都要审批，要严的宿主用 `override` 或 `approval({ unmatched: "ask" })`。
- **run 起步 list 失败缺省抛** — fail-closed，宿主一定知道；`optional: true` 才降级成空表，且模型会从工具变化说明看到工具没了，不是静默少一批。
- **模型侧工具名改写** — Anthropic / OpenAI 要求 `^[A-Za-z0-9_-]{1,64}$`，MCP 没这限制；不改写请求会 400。改写只在模型侧，调用按原名。
- **0.1 不做** sampling / elicitation / resources / prompts / MCP Apps / OAuth 流程（`headers` 或自带 `fetch` 即可接简单鉴权）。
