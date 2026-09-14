/**
 * @reinsjs/server 的公开类型（技术方案 §12）。
 *
 * 设计要点：
 * - handler 是 Web 标准的 `(Request) => Promise<Response>`，不依赖任何运行时私有 API，Node / Bun / Workers / Deno 同一份代码。
 * - 流里推的就是时间线事件本身（宪法二）：SSE 的 `id:` 字段 = 事件 seq，浏览器 EventSource 断线重连自动带
 *   `Last-Event-ID`，服务端从 EventLog 补发 —— 重连不需要 Redis，也不需要额外的"消息队列"。
 * - 编码可换：缺省原样推事件；`@reinsjs/ui-agui`（T13）提供 AG-UI 编码器，同一个 handler 换一个 encode 即可。
 */
import type {
  ApprovalDecisionInput,
  ContentPart,
  Event,
  EventDraft,
  LoopConfig,
  LoweringDelta,
  MaybePromise,
  Principal,
  RunResult,
  SerializedRunState,
} from "@reinsjs/core"
import type { RunRegistry } from "./runs.js"

// ---- agent 定义 ----

/**
 * 一个 agent = 一份跨请求不变的循环配置：模型、工具、脑子（sockets）、存储、密钥……
 * 每次请求才知道的字段（sessionId、input、resume、decisions、signal、onDelta、principal）由 handler 按请求填。
 */
export type AgentDefinition = Omit<
  LoopConfig,
  "sessionId" | "input" | "resume" | "decisions" | "signal" | "onDelta" | "principal"
>

// ---- 请求 ----

/**
 * POST 请求体。四种用法都是同一个形状：
 * - 新会话：只给 input（sessionId 缺省由服务端生成，回在 start 帧与 `X-Reins-Session` 头里）
 * - 续聊：sessionId + input
 * - 审批后续跑：sessionId + resume（上次 result 帧里的 state）+ decisions（子代理的审批带 `sessionId: childSessionId`，见 Interruption(kind=subagent)）
 * - 补发缺口：任何一种加 lastSeq —— 先把 (lastSeq, 当前末尾] 的事件补给客户端，再开始新的 run
 */
export interface AgentRequestBody {
  sessionId?: string
  input?: string | ContentPart[] | EventDraft
  /** 客户端已收到的最后一个 seq；缺省 0（从头补发） */
  lastSeq?: number
  resume?: SerializedRunState
  decisions?: ApprovalDecisionInput[]
}

// ---- 流内容 ----

/**
 * 流里的每一项。编码器把它翻译成零到多个 SSE 帧。
 * 一条流的形状：start → (event | delta)* → (result | end | error)，最后一项之后连接关闭。
 * - result：本流挂着一个 run，run 结束后给出四态之一（paused 时含可回传的 state）
 * - end：本流只是补发（没有 run 在跑），补发完即结束
 * - error：run 在写第一条日志前就失败（恢复校验不过、存储并发冲突等）；日志里已有的 core.error 仍以 event 推出
 */
export type StreamItem =
  | { kind: "start"; sessionId: string; fromSeq: number; live: boolean }
  | { kind: "event"; event: Event; replay: boolean }
  | { kind: "delta"; delta: LoweringDelta }
  | { kind: "result"; result: RunResult }
  | { kind: "end"; sessionId: string; lastSeq: number }
  | { kind: "error"; code: string; message: string }

/** 一个 SSE 帧。data 会被 JSON.stringify（字符串也一样，客户端统一 JSON.parse） */
export interface SseFrame {
  event?: string
  /** 只有时间线事件带 id（= seq），控制帧不带，这样 Last-Event-ID 永远指向真实事件 */
  id?: string
  data: unknown
}

/** 编码器：StreamItem → SSE 帧。缺省 rawEncoder 原样推事件；AG-UI 编码器在 @reinsjs/ui-agui */
export type StreamEncoder = (item: StreamItem) => readonly SseFrame[]

/**
 * 每条流开始时调用一次，返回该流专用的编码器。编码器可以有状态（AG-UI 要把流式增量与随后的完整事件接成
 * 同一条消息），而多条流会并发交错，所以状态必须按流隔离 —— handler 拿到的是工厂而不是编码器本身。
 */
export type StreamEncoderFactory = () => StreamEncoder

// ---- handler ----

/** 宿主运行时可选传入的上下文。Cloudflare Workers 的 ExecutionContext 结构兼容，直接透传即可 */
export interface HandlerContext {
  /** 客户端断开后 run 仍在后台跑完，Workers 需要 waitUntil 才不会被回收 */
  waitUntil?(promise: Promise<unknown>): void
}

/** 传给 `HandlerOptions.authorizeSession` 的一次会话访问请求。 */
export interface SessionAuthzInput {
  /** 已解析出的会话 id：GET 取自 query，POST 取自请求体（没带则是服务端刚生成的新 id） */
  sessionId: string
  /** `principal` 钩子的解析结果；没设那个钩子或返回 undefined 时为 undefined（匿名） */
  principal: Principal | undefined
  /**
   * 原始请求，**只用来读 header / cookie 等**。
   *
   * POST 时 body 已经被 handler 读完了（`request.json()` 在解析出 sessionId 之前就调过），
   * 在这里再读只会得到空流；GET 本来就没有 body。要 sessionId 用上面的 `sessionId` 字段，
   * 别自己解析请求。
   *
   * 与 `principal` 钩子的差别正好相反，两处都别读 body 但原因不同：`principal` 跑在 handler
   * 读 body **之前**，在那里读会把流抢走；这个钩子跑在**之后**，读不到东西。
   */
  request: Request
  /** GET 是重连读流，POST 是起 run。宿主可以只对写放行给部分人 */
  method: "GET" | "POST"
  /**
   * 这次是不是要新建会话（POST 没带 sessionId，id 是服务端刚生成的）。
   * 新会话还没有归属，宿主通常一律放行、并在返回前自行把 sessionId 记到自己的归属表里。
   */
  isNew: boolean
}

/** 传给 `HandlerOptions.onEvent` 的上下文：这条事件属于哪条会话、由谁发起的 run、来自哪个请求。 */
export interface EventObserverInput {
  /** 事件所属会话（= run 的会话；子代理会话的事件不经这里，见 `onEvent` 说明） */
  sessionId: string
  /** `principal` 钩子的解析结果；没设那个钩子或返回 undefined 时为 undefined（匿名） */
  principal: Principal | undefined
  /**
   * 发起这个 run 的 POST 请求，**只用来读 header**（traceId、request-id、cookie 之类）。
   * body 早已被 handler 读完，在这里读只会得到空流。
   */
  request: Request
}

export type AgentHandler = (request: Request, ctx?: HandlerContext) => Promise<Response>

export interface HandlerOptions {
  /** 每条流一个编码器实例；缺省 `() => rawEncoder` */
  encode?: StreamEncoderFactory
  /** 是否推流式增量（delta 项）；缺省 true。日志里只有完整内容块，增量只给 UI 用 */
  deltas?: boolean
  /**
   * 发起 run 的客户端断开时怎么办。缺省 "continue"：run 跑完为止（模型的工作不因关掉标签页而丢），
   * 客户端带 lastSeq 重连即可接上。"abort" 则中止 run（降级层收到 signal → paused(host)）。
   */
  onDisconnect?: "continue" | "abort"
  /** SSE 注释心跳间隔（毫秒），防代理断闲置连接；缺省 15000，0 关闭 */
  heartbeatMs?: number
  /**
   * 从请求解析主事人（鉴权）。返回 undefined 表示匿名；要拒绝请求就 throw 一个 Response（原样返回）。
   * 解析结果透传给循环（工具与钩子可读），库不解释其字段。
   */
  principal?(request: Request): MaybePromise<Principal | undefined>
  /**
   * 会话级鉴权：handler 解析出 sessionId **之后**、读写这条会话的任何日志之前调用，
   * 决定这个主事人能不能碰这条会话。
   *
   * 为什么单独一个钩子而不是让宿主在 `principal` 里判：`principal` 只拿到 Request，
   * 而 POST 的 sessionId 在**请求体**里 —— 宿主要在那里判归属就得 `clone()` 去读 body，
   * 而 handler 随后还要再读一次。GET 的 sessionId 虽在 query 里可解析，但两条路各写一遍
   * 归属判定容易漏。所以由 handler 统一解析好再回调。
   *
   * **只有显式返回 `true` 才放行**；`false` 或 `undefined` 一律拒绝（回 404，见下）；
   * 要自定应答就 throw 一个 Response（原样返回，与 `principal` 一致）。
   *
   * 为什么不让"什么都不返回"算放行：鉴权钩子必须 fail-closed。宿主某条分支漏写 return
   * 就得到 undefined —— 那时拒绝会让会话立刻打不开、当场发现，放行则是一个安静的越权漏洞。
   * 与 schema 读、审批、resume 校验同一原则。
   *
   * 拒绝为什么是 404 而不是 403：403 等于告诉对方"这条会话存在，只是你不能看"。
   * 与外溢 blob 的授权规则一致（未被引用的 id 一律当不存在，不泄露）。
   *
   * **不设这个钩子时 handler 不做任何会话归属检查** —— 只要知道 sessionId 就能读整条时间线。
   * 多租户宿主必须设它。
   */
  authorizeSession?(input: SessionAuthzInput): MaybePromise<boolean | undefined>
  /** 新会话 id 工厂；缺省 uuidv7 */
  newSessionId?(): string
  /**
   * 正在跑的 run 的登记表。同一会话同时只允许一个 run（第二个 POST 得 409）；
   * GET 重连撞上本进程正在跑的 run 时，补发之后继续实时推。多个 handler 共用同一个进程时可传同一个实例。
   *
   * 缺省 `new InMemoryRunRegistry()`，**只认本进程**——多实例部署下两台机器可以同时对一条会话起 run，
   * 第二个浪费一次模型调用后撞 `seq_conflict`。多实例必须传 `leasedRunRegistry(store.runLease)`（D4），
   * `createAgent({ store })` 见 `store.runLease` 会自动装。
   */
  runs?: RunRegistry
  /**
   * 旁路观测：经这个 handler 起的 run 每 append 一条事件，就以 seq 顺序调一次。**只观测不改事件**——
   * 时间线已经写下了，这里拿到的是同一个对象的引用，改它改不了日志，只会让 SSE 订阅者看到与日志不一致的东西。
   *
   * 用途是把 HTTP 路径的 run 接到宿主自己的日志 / 追踪：`input.request` 读 traceId、`input.principal` 读 userId。
   * 进程内直接 `agent.run()` 的不需要它——`runLoop` 本就是逐条 yield 事件的生成器，`for await` 就是观测。
   *
   * 边界：
   * - **只有 live 事件**：补发（POST 带 `lastSeq`、GET 重连）从日志重读的事件不再调，否则同一条事件会被观测两次。
   * - 只有本会话的事件：`asTool` 子代理跑在自己的会话里，不经 handler，这里看不到它们的内部事件（父会话里的 tool_call / tool_result 看得到）。
   * - **不挡 run**：先把事件推给 SSE 订阅者再调钩子；返回 promise 的话按事件顺序串成一条链，但 run 不等它就拉下一条事件。
   *   run 收尾时（result 帧之前、`ActiveRun.done` resolve 之前）等整条链结束，所以 Workers 的 `waitUntil(run.done)` 覆盖到最后一次观测。
   * - **出错不上抛**：钩子 throw 或 reject 一律不影响 run，经 `warn` 报出，一次 run 只报一次。观测者挂了不该让模型的工作跟着挂。
   */
  onEvent?(event: Event, input: EventObserverInput): MaybePromise<void>
  /** 告警出口（目前只有 `onEvent` 出错这一种）；缺省 console.warn */
  warn?: (message: string) => void
}
