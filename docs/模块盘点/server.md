# 模块盘点：`@reinsjs/server`

> 依据 `packages/server/src/` 的实际代码（2026-09-10，`main` @ 9e0b99e）。与 `docs/技术方案.md` §12、根 `README.md` 的 Security notes 相互核对，冲突以代码为准。

## 1 架构概览

`@reinsjs/server` 只做一件事：把 `@reinsjs/core` 的 `runLoop` 装进一个 Web 标准 handler —— `(Request, ctx?) => Promise<Response>`。主入口不碰任何 `node:*`，Node / Bun / Workers / Deno 用同一份代码；运行时依赖只有 `@reinsjs/core`。

它不做路由、不做 CORS、不做鉴权实现，只留两个鉴权钩子（`principal` 解析"谁在问"，`authorizeSession` 决定"他能碰哪条会话"）。传输格式也不绑死：SSE 帧由可替换的编码器工厂产出，缺省原样推时间线事件，AG-UI 编码器在 `@reinsjs/ui-agui`。

```
Request ──▶ options.principal(request)?            抛 Response → 原样返回
              │
   ┌──────────┴───────────────────────────────────────────────────┐
   │ GET  ?sessionId=&lastSeq=            │ POST  {sessionId?,input?,lastSeq?,resume?,decisions?}
   │  1 sessionId 非空 + SESSION_ID_RE    │  1 request.json() + parseBody           → 400
   │      → 400                           │  2 sessionId = body.sessionId ?? newSessionId()
   │  2 authorizeSession(GET,isNew=false) │  3 authorizeSession(POST,isNew=?)       → 404
   │      → 404 / 抛 Response             │  4 预校验（仅当 resume / decisions / input 为草稿）：
   │  3 lastSeqOf：Last-Event-ID 头       │      readTimeline → validateResume(configHash)
   │      优先于 ?lastSeq  → 400          │      → decisions 必须指向 pending → checkInput 白名单
   │  4 runs.get(sessionId)：命中就挂上    │                                          → 409 / 400
   │      本进程正在跑的那个 run          │  5 runs.create(sessionId)               → 409
   │                                      │  6 ctx.waitUntil(run.done)（Workers）
   └──────────┬───────────────────────────┴──────────────┬───────────┘
              │                 其它方法 → 405            │
              ▼                                          ▼
                          openStream(plan)  —— 立刻返回 200，其余在 ReadableStream 里异步进行
              ┌──────────────────────────────────────────────────────────┐
              │ ① 有 run 就先 subscribe（补发期间的事件先攒进队列）        │
              │ ② fromSeq = min(请求的 fromSeq, 日志末尾 seq + 1)（钳位）  │
              │ ③ start 帧                                               │
              │ ④ readEvents 逐条补发（replay=true），记 maxSeq           │
              │ ⑤ 无 run → end 帧 → close                                │
              │ ⑥ 有 run → begin() 起 runLoop → drain 已攒信号（按 seq    │
              │    去重、丢弃 delta）→ 实时 event / delta                 │
              │ ⑦ result 或 error 帧 → close                             │
              └──────────────────────────────────────────────────────────┘
                                     │
                          SSE 200 + X-Reins-Session: <sessionId>
```

## 2 文件清单

| 路径 | 职责 |
| --- | --- |
| `packages/server/package.json` | 包元数据：两个 exports（`.` 与 `./node`）、运行时只依赖 `@reinsjs/core`、devDep 里 miniflare pin 在 `4.20260730.0` |
| `packages/server/tsconfig.json` | 加了 `types: ["node"]`（供 tsup 为 `./node` 子路径出声明），引用 `../core` |
| `packages/server/tsup.config.ts` | 两个入口打 ESM + `.d.ts`；打声明时清空 `paths`，否则 core 的类型会被内联而不是保留 import |
| `packages/server/src/index.ts` | 公开面：`createAgentHandler` / `DEFAULT_HEARTBEAT_MS` / `SESSION_HEADER`、runs 三件套、sse 四件套、`export type * from "./types.js"` |
| `packages/server/src/types.ts` | 全部公开类型：`AgentDefinition`（= `LoopConfig` 去掉七个按请求填的字段）、`AgentRequestBody`、`StreamItem` / `SseFrame` / `StreamEncoder(Factory)`、`HandlerContext`、`SessionAuthzInput`、`HandlerOptions` |
| `packages/server/src/handler.ts` | 主体（513 行）：`createAgentHandler` 以及 `SESSION_ID_RE`、`parseBody`、`checkInput`、`lastSeqOf`、`openStream`、`denyBySessionAuthz`、`handleGet`、`handlePost` |
| `packages/server/src/sse.ts` | `encodeSseFrame`（WHATWG SSE 帧格式，data 一律 `JSON.stringify` 故只需一行）、`SSE_HEARTBEAT`（`": ping"` 注释行）、`SSE_HEADERS`（含 `x-accel-buffering: no` 让 nginx 不缓冲）、`rawEncoder` |
| `packages/server/src/runs.ts` | 进程内 run 登记：`Channel<T>`（单生产者多消费者、可 `drain()`）、`ActiveRun`（`subscribe` / `broadcast` / `drive` / `abandon` / `done`）、`RunRegistry`（`create` 占名额、结束时只删自己）、`RunConflictError`（code `run_in_progress`） |
| `packages/server/src/node.ts` | `./node` 子路径：`nodeListener(handler, ctx?)` 把 `IncomingMessage/ServerResponse` 翻成 `Request`/写回响应流；唯一允许出现 `node:*` 的位置（只是 `import type`），`res.on("close")` 时 `reader.cancel()` 让 handler 感知客户端断开 |
| `packages/server/src/test-utils.ts` | 测试辅助（只被 `*.test.ts` 引用）：`parseFrames`、逐帧读的 `FrameReader`、可控闸门 `gate()`、`postRequest` / `getRequest` / `openReader` 与断言小工具 |
| `packages/server/src/workers.fixture.ts` | Workers 测试用的 Worker 脚本，也是"在 Workers 上怎么用"的最小示例：模块级 `log` 跨请求存活，`fetch(request, env, ctx)` 直接转交 handler 并统计 `waitUntil` 次数 |
| `packages/server/src/handler.test.ts`、`src/workers.test.ts` | 测试。覆盖：POST 首轮流式推与 `id` = seq、续聊补发不重复、lastSeq 越界钳位、`deltas:false` 与自定义编码器、GET 重连（`Last-Event-ID` 优先于 query、撞上正在跑的 run 继续推）、同会话第二个 POST 409、发起者断开的 continue / abort 两种行为、审批暂停与跨请求恢复（含带静态贡献 Socket 时 configHash 一致、篡改 state / 指错 decision / 换密钥一律 409 且一条日志不写）、请求校验与 `principal` 钩子、input 草稿白名单（伪造 approval_decision 400、user_message 只取 content、tool_result 只能回填 pending 的客户端工具）、R6 `authorizeSession`（不设钩子不检查、404 且日志一次没读、isNew、抛 Response、POST 时 body 已被读完、fail-closed）、sessionId 字符集 400、真实 node:http 经 TCP 验证"确实在流式推"、miniflare/workerd 上 POST + GET + waitUntil |

## 3 核心流程

**入口分发**（`createAgentHandler` 返回的闭包）

1. `await options.principal?.(request)` —— 在读 body **之前**跑，所以钩子里不能读 body（会把流抢走）。抛出的 `Response` 原样返回，其它异常照常冒泡。
2. `request.method` 分发到 `handleGet` / `handlePost`，其余方法 405 并带 `allow: GET, POST`。

**POST：起一个 run**（`handlePost`）

1. `request.json()` 失败 → 400 `bad_request`。
2. `parseBody` 只做壳校验：请求体必须是非数组对象；`sessionId` 过 `isValidSessionId`；`lastSeq` 非负整数；`input` 是字符串 / 数组 / 带 `type`+`payload` 的对象；`decisions` 每项含 `toolCallId`+`approved`+`by`（`sessionId` 可选，给子代理会话的结论，见 core `SubagentInterruption`；同样过 `isValidSessionId`）；`resume` 是对象。`resume` 的形状与签名留给 core 的 `validateResume`。
3. `sessionId = body.sessionId ?? newSessionId()`（缺省 `uuidv7()`）。
4. `denyBySessionAuthz({ sessionId, principal, request, method:"POST", isNew: body.sessionId === undefined })` —— 排在 `readTimeline` / `validateResume` 之前，因为那两步已经在读这条会话的日志了。
5. 预校验分支：只有 `body.resume !== undefined`、`decisions` 非空、或 `input` 是草稿三者之一成立时才进。里面依次 `readTimeline(log, sessionId, { registry })` → （有 resume 时）`validateResume`，其 `configHash` 用 `computeConfigHash({ model, ...(await resolveSocketContributions(agent)) })` 算（P1 起 async），与 `runLoop` 起步同一份算法 → `decisions` 按 `sessionId` 分流（与 runLoop §10.1 同口径，2026-09-10 审查修）：没带或等于本会话的必须指向 `pendingToolCalls(timeline)` 里的调用，否则抛 `RunStateError("unknown_tool_call")`；带别的会话 id（子代理）的不校验、原样下传给 asTool → `checkInput(body.input, pending, contributions.tools)`。`RunStateError` 一律翻成 409 + 其 `code`。
6. `checkInput` 是面向网络的第一道白名单（循环层 `inputDraft` 是第二道）：字符串 / `ContentPart[]` / `undefined` 直接放行；草稿只放行两种，且壳字段一律由服务端定 ——
   - `core.user_message`：只取 `payload.content`（须过 `isContentParts`），`actor` 固定 `user`；
   - `core.tool_result`：`toolCallId` 必须在 pending 里（否则 409 `unknown_tool_call`），对应工具必须是客户端工具（`!tool.execute` 或 `tool.side === "client"`，否则 400），`name` / `parentId` / `provenance` 取自 tool_call，客户端只能决定 `content` 与 `isError`；
   - 其余类型一律 400 —— 一条伪造的 `approval_decision(approved=true)` 就能让 pending 调用免审批执行。
7. `runs.create(sessionId)` 占名额，撞上已有 run 抛 `RunConflictError` → 409 `run_in_progress`（这一条**带 `X-Reins-Session` 头**）。
8. `ctx?.waitUntil?.(run.done)`，让 Workers 不在响应结束时回收后台 run。
9. `openStream({ sessionId, fromSeq: (body.lastSeq ?? 0) + 1, log, run, begin, starter: true })`。`begin` 里才真正 `runLoop({ ...agent, sessionId, signal, input?, resume?, decisions?, principal?, onDelta? })` 并交给 `run.drive(gen)`。

**GET：重连补发**（`handleGet`）

1. `?sessionId` 缺失或空 → 400；不过 `SESSION_ID_RE` → 400（query 同样是客户端输入）。
2. `denyBySessionAuthz(..., method:"GET", isNew:false)` —— GET 拿到 sessionId 就能补发整条时间线，这里是唯一关口。
3. `lastSeqOf`：`Last-Event-ID` 请求头优先于 `?lastSeq`（重连时浏览器自动带、更新），非负整数校验不过 → 400。
4. `runs.get(sessionId)` 命中就把正在跑的 run 挂上；`starter: false`，所以这条连接断开不会影响 run。

**流的内部**（`openStream`，POST / GET 共用）

1. `makeEncoder()` 每条流一个编码器实例（编码器可有状态，多流并发必须隔离）；`heartbeatMs > 0` 时起一个 `setInterval` 定期写 `": ping"`。
2. `pump()`：有 run 就**先 subscribe 再补发**，补发期间 run 推出的信号先攒在 `Channel` 里。
3. `fromSeq = Math.min(plan.fromSeq, tailSeq + 1)` —— 客户端报的 lastSeq 超过日志末尾（换了会话、存储被清）就钳到末尾，否则之后的实时事件会被当成"已补发过"静默丢掉。
4. `start` 帧（`sessionId` / `fromSeq` / `live`）→ `readEvents(log, sessionId, { registry, fromSeq })` 逐条 `event` 帧（`replay: true`），记录 `maxSeq`。
5. 无 run：`end` 帧（带 `lastSeq`）后关闭。
6. 有 run：`begun = true`、`plan.begin?.()` 起跑 —— 补发期间客户端就算走了也照跑。先 `sub.drain()` 把攒下的信号推出（`seq <= maxSeq` 的事件跳过，delta 全部丢弃），再 `for await` 实时转发；收到 `result` 或 `error` 即收尾关闭。
7. `pump()` 抛错（补发读日志失败等）→ `error` 帧 + 关闭；若本连接是发起者且 run 还没开跑，`run.abandon(code, message)` 把名额还回去，否则这条会话会永久 409。
8. `cancel()`（客户端断开）：清心跳、退订；发起者 + `onDisconnect === "abort"` 时 `run.controller.abort()`（还没开跑也没关系，`runLoop` 拿到的是已中止的 signal → `paused(host)`）。缺省 `"continue"`，run 跑完为止。

**帧与响应头**

- 缺省 `rawEncoder`：时间线事件帧**不带 `event` 名**（落 `EventSource.onmessage`）、`id:` = `event.seq`；控制项带 event 名 `start` / `delta` / `result` / `end` / `error`，只监听 `onmessage` 的客户端自然看不到。换 `options.encode` 即整套替换（`aguiEncoding()` 见 `@reinsjs/ui-agui`）。
- 所有 SSE 响应带 `SSE_HEADERS` + `X-Reins-Session`（常量 `SESSION_HEADER = "x-reins-session"`），客户端不必等 `start` 帧就能拿到会话 id。

**错误码表**

| 码 | error | 触发点 |
| --- | --- | --- |
| 400 | `bad_request` | 请求体不是合法 JSON；`parseBody` 任一壳校验不过；sessionId 越界字符（GET query / POST body 两条路）；GET 缺 `sessionId`；`lastSeq` 不是非负整数；input 草稿类型不在白名单 / content 形状不对 / 想回填服务端工具的结果 |
| 404 | `not_found` | `authorizeSession` 没有显式返回 `true`（`false` 或 `undefined`）。刻意不用 403 |
| 405 | `method_not_allowed` | GET / POST 之外的方法，带 `allow` 头 |
| 409 | `unknown_tool_call` | `decisions` 或 `tool_result` 草稿指向的调用不在 pending 里 |
| 409 | `RunStateError.code` | `validateResume` 不过（会话不符、state 被篡改、密钥不同、配置漂移等），码由 core 给 |
| 409 | `run_in_progress` | 同一会话已有 run 在本进程跑；跨进程靠 EventLog 的 `seq_conflict` 兜底 |
| 200 + `error` 帧 | — | 流已经开了才出的错（补发读日志失败、run 在写第一条日志前失败）。日志里已有的 `core.error` 仍以 `event` 帧推出 |
| 抛出的 `Response` | 宿主自定 | `principal` 与 `authorizeSession` 抛 `Response` 一律原样返回 |

## 4 核心设计决策

- **T12 缺省推原始时间线事件，AG-UI 只是可插编码器** — SSE 的 `id:` 直接用事件 `seq`，控制帧不带 id，所以 `Last-Event-ID` 永远指向真实事件。理由是宪法二：时间线是唯一真源，前端协议只是翻译，server 不该绑死一种。边界：编码器与请求体形状 DECISIONS 标注"发布前可调"。
- **T12 重连补发零额外状态** — 客户端记住最后一个 `id`，服务端从 EventLog 读 `(lastSeq, 末尾]`。不需要 Redis、不需要消息队列。边界：只在 EventLog 里的东西补得回来，`delta` 补不回（补发期间攒下的 delta 直接丢弃，因为它们所属的内容块要么已在补发里完整出现，要么不久后会完整到达）。
- **T12 POST 先补发再起 run，GET 先订阅再补发** — 两条路都保证"补发的和实时的不重不漏"：POST 的 run 在补发完成后才 `begin()`，GET 靠 `maxSeq` 去重。
- **T12 同会话同时只允许一个 run** — 进程内 `RunRegistry` 给 409；跨进程不做分布式锁，靠 EventLog 的 seq 连续性校验（append 报 `seq_conflict`）兜底。
- **T12 发起者断开缺省不中止 run** — `onDisconnect: "continue"`，理由是"模型的工作不应因用户关掉标签页而丢"，重连带 lastSeq 即接上；Workers 靠 `ctx.waitUntil(run.done)` 不被回收。想要旧行为传 `"abort"` → `paused(host)`。
- **T12 resume / decisions 开流前预校验** — 目的只是把 409 提前给出来，"4xx 比 200 + error 帧对客户端友好"。**fail-closed 不靠这里**：循环内部照旧再校验一次。边界：预校验的 `configHash` 必须与循环同一份算法 —— B6 修过的坑，只用宿主工具算会让装了任何带静态贡献的 Socket（compact / memory）的会话续跑时误判配置漂移而 409。
- **R6 鉴权拆两层，`authorizeSession` fail-closed 且拒绝回 404** — `principal(request)` 只解析"谁在问"，`authorizeSession({sessionId, principal, request, method, isNew})` 决定"他能碰哪条会话"，在解析出 sessionId 之后、读写该会话任何日志之前调用。为什么不合成一个：POST 的 sessionId 在**请求体**里，宿主想在 `principal` 里判归属就得 `clone()` 读 body 而 handler 随后还要再读一次 —— 对 POST 来说宿主做不到。只有显式 `true` 放行，`undefined`（漏写 `return`）与 `false` 一样拒，因为"漏写该当场锁死而不是安静放行"；用 404 而非 403 是因为 403 等于确认这条会话存在，与外溢 blob "未被引用的 id 一律当不存在"同一规则。**边界：不设这个钩子时 handler 不做任何会话归属检查**（缺省不检查而非默认拒绝，是因为单租户与本地开发是主流用法），多租户宿主必须设它，README Security notes 明示。
- **R6 顺带：`SESSION_ID_RE = /^[\x21-\x7e]+$/`** — sessionId 要回写进 `X-Reins-Session` 头，越界值会让 `new Response(...)` 抛 TypeError 冒出 handler，把一个该 400 的请求变成 500（实测中文 / emoji / CRLF / 裸 LF / NUL / 空格全中）。**CRLF 被 Response 构造器挡住，不构成注入漏洞**。取比运行时真实边界（latin1）更严：`é` 实测能过也照拒 —— 一句"可打印 ASCII 不含空格"说得清、各处一致，且 header 值首尾空格会被 trim 会让回写值与传入值不是同一字符串。边界：uuid / nanoid / hex / `user:42/sess-7` 一律通过；放宽只需改一条正则。
- **上线前审查：input 草稿两道白名单，server 层更严** — 网络端点原样接受任何草稿是实测过的洞（伪造 `approval_decision(approved=true)` 让 pending 调用免审批执行，伪造 `system_note` 带 system 信任，伪造 `compaction` 能藏历史）。审批结论只能走 `decisions`（走 T10 校验）。分两层是因为循环在进程内也可能被宿主拿不可信输入直接调用。
- **`encode` 是按流的工厂而不是编码器本身** — AG-UI 编码器要把流式增量与随后的完整事件接成同一条消息，是有状态的；多条流会并发交错，状态必须按流隔离。
- **补发与预校验读日志都经注册表升级（P9）** — `readEvents` / `readTimeline` 都传 `agent.registry ?? createCoreRegistry()`，让流里的事件形状与循环看到的一致；宿主有 `ext.*` 事件时在 definition 里给自己的注册表。
- **`./node` 子路径是唯一允许 `node:*` 的位置** — 主入口保持纯 Web 标准（工程硬约束）。Hono / TanStack Start / Fastify 自带同类适配，这十几行只给"只想 `node server.ts` 跑起来"的人。
