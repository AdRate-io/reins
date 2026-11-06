/**
 * createAgentHandler：把 runLoop 装进一个 Web 标准 handler（技术方案 §12）。
 *
 *   POST  body: { sessionId?, input?, lastSeq?, resume?, decisions? }
 *         → 补发 (lastSeq, 末尾] 的事件 → 起一个 run → 实时推每条刚 append 的事件 → result 帧 → 关闭
 *   POST  body: { sessionId, stop: true } → 停止（JSON 应答，不开流；见 AgentRequestBody.stop）
 *   POST  body: { sessionId, input, deliveryId? } 打在本进程正在跑的 run 上且开了 midRunInput
 *         → 入这个 run 的信箱，回 202 JSON（不开流）；run 在下一次调模型前写进时间线（见 HandlerOptions.midRunInput）
 *   GET   ?sessionId=…&lastSeq=N   （或 Last-Event-ID 头，EventSource 重连时自动带）
 *         → 补发 (N, 末尾] → 若本进程正有该会话的 run 在跑则继续实时推到 result；否则 end 帧 → 关闭
 *
 * 事件的 SSE `id:` 就是 seq，所以"重连补发"不需要任何额外状态：客户端记住最后一个 id，服务端从日志读。
 * 同一会话同时只允许一个 run（409）；发起者断开缺省不中止 run，日志照常写，重连即接上。
 * 登记表缺省只在进程内（`InMemoryRunRegistry`）；多实例部署传 `runs: leasedRunRegistry(store.runLease)`。
 */
import {
  type ContentPart,
  computeConfigHash,
  createCoreRegistry,
  type Event,
  type EventDraft,
  type EventLog,
  type LoopConfig,
  type Principal,
  pendingToolCalls,
  type RunResult,
  RunStateError,
  RunStop,
  readEvents,
  readTimeline,
  resolveSocketContributions,
  runLoop,
  type Tool,
  type ToolCallEvent,
  uuidv7,
  validateResume,
} from "@reinsjs/core"
import { claiming, MAILBOX_LIMIT, Mailbox, USER_DELIVERY_SOURCE } from "./mailbox.js"
import {
  type ActiveRun,
  type Channel,
  InMemoryRunRegistry,
  RunConflictError,
  type RunRegistry,
  type RunSignal,
} from "./runs.js"
import { encodeSseFrame, rawEncoder, SSE_HEADERS, SSE_HEARTBEAT } from "./sse.js"
import type {
  AgentDefinition,
  AgentHandler,
  AgentRequestBody,
  EventObserverInput,
  HandlerContext,
  HandlerOptions,
  QueuedResponse,
  SessionAuthzInput,
  StopResponse,
  StreamEncoder,
  StreamEncoderFactory,
  StreamItem,
} from "./types.js"

export const DEFAULT_HEARTBEAT_MS = 15_000

/** 会话 id 回在响应头里，客户端不必等 start 帧就能拿到（新会话时尤其有用） */
export const SESSION_HEADER = "x-reins-session"

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })
}

function isNonNegativeInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0
}

/**
 * 可打印 ASCII，不含空格。sessionId 要回写进 `X-Reins-Session` 响应头，
 * 而 HTTP header 值只能装 latin1 且不能有控制字符 —— 越界的值会让 `new Response(...)`
 * 抛 TypeError（实测中文、emoji、CRLF、NUL 全部如此；CRLF 注入被运行时挡住，不是漏洞，
 * 但异常会冒出 handler 变成 500 而不是一个明确的 400）。
 *
 * 为什么比 latin1 更严（`é` 其实能过却也拒掉）：一句"可打印 ASCII 不含空格"能说清、
 * 各处一致；latin1 高位字符在不同解码下有歧义，而 header 值的首尾空格会被 trim，
 * 让回写的 sessionId 与客户端给的不是同一个字符串 —— 那种不一致比直接拒绝更难查。
 * uuidv7、nanoid、hex、`user:1/sess-2` 这类实际用法一律通过。
 */
const SESSION_ID_RE = /^[\x21-\x7e]+$/

function isValidSessionId(x: unknown): x is string {
  return typeof x === "string" && SESSION_ID_RE.test(x)
}

/** deliveryId 与 sessionId 同一字符规则（可能被客户端拿去当 header / 选择器），另加长度上限 */
const DELIVERY_ID_MAX = 128

function isValidDeliveryId(x: unknown): x is string {
  return isValidSessionId(x) && x.length <= DELIVERY_ID_MAX
}

/** 用户消息形态的 input：字符串、内容片段（parseBody 已重建）、或 `core.user_message` 草稿 */
function isUserMessageInput(
  input: AgentRequestBody["input"],
): input is NonNullable<AgentRequestBody["input"]> {
  if (input === undefined) return false
  if (typeof input === "string" || Array.isArray(input)) return true
  return (input as EventDraft).type === "core.user_message"
}

/**
 * 请求体只做壳校验；resume 的形状与签名交给 core 的 validateResume，草稿的类型白名单在 checkInput 与循环。
 * 例外是数组 input：在这里无条件按白名单重建成内容片段——不带 resume / decisions 的请求不经过 checkInput，
 * 而循环层认草稿数组（只给进程内宿主），放过去就能从网络写进 system 信任的说明（踩坑 10 同类）
 */
function parseBody(raw: unknown): { ok: true; body: AgentRequestBody } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "request body must be a JSON object" }
  }
  const b = raw as Record<string, unknown>
  if (b.sessionId !== undefined && !isValidSessionId(b.sessionId)) {
    return { ok: false, error: "sessionId must be a non-empty printable ASCII string with no spaces" }
  }
  if (b.lastSeq !== undefined && !isNonNegativeInt(b.lastSeq)) {
    return { ok: false, error: "lastSeq must be a non-negative integer" }
  }
  if (Array.isArray(b.input)) {
    const parts = rebuildContentParts(b.input)
    if (!parts)
      return {
        ok: false,
        error: "input content parts must be a non-empty array of text, image, video or audio parts",
      }
    b.input = parts
  } else if (b.input !== undefined) {
    const okInput =
      typeof b.input === "string" ||
      (typeof b.input === "object" && b.input !== null && "type" in b.input && "payload" in b.input)
    if (!okInput)
      return { ok: false, error: "input must be a string, an array of content parts, or an event draft" }
  }
  if (b.decisions !== undefined) {
    const okDecisions =
      Array.isArray(b.decisions) &&
      b.decisions.every(
        (d) =>
          typeof d === "object" &&
          d !== null &&
          typeof d.toolCallId === "string" &&
          typeof d.approved === "boolean" &&
          typeof d.by === "string" &&
          (d.sessionId === undefined || isValidSessionId(d.sessionId)),
      )
    if (!okDecisions)
      return {
        ok: false,
        error:
          "every decisions entry must carry toolCallId / approved / by (sessionId is optional and addresses a subagent session; it follows the same character rules as the request's sessionId)",
      }
  }
  if (b.resume !== undefined && (typeof b.resume !== "object" || b.resume === null)) {
    return { ok: false, error: "resume must be an object" }
  }
  if (b.stop !== undefined) {
    if (b.stop !== true) return { ok: false, error: "stop must be true" }
    if (b.sessionId === undefined) return { ok: false, error: "stop requires a sessionId" }
    if (
      b.input !== undefined ||
      b.resume !== undefined ||
      b.decisions !== undefined ||
      b.deliveryId !== undefined
    )
      return { ok: false, error: "stop cannot be combined with input, resume, decisions or deliveryId" }
  }
  if (b.deliveryId !== undefined) {
    if (!isValidDeliveryId(b.deliveryId))
      return {
        ok: false,
        error: `deliveryId must be a non-empty printable ASCII string with no spaces, at most ${DELIVERY_ID_MAX} characters`,
      }
    if (!isUserMessageInput(b.input as AgentRequestBody["input"]))
      return {
        ok: false,
        error: "deliveryId requires a user message input (text, content parts or a core.user_message draft)",
      }
  }
  return { ok: true, body: b as AgentRequestBody }
}

/**
 * 网络来的内容片段按白名单重建：非空、只收 text / image / video / audio，每个片段只留该类型的字段（壳字段由服务端定）。
 * 多余字段（如 actor）因此不可能进到循环、改变它对 input 的判别；不合规返回 undefined。
 * video / audio 的形状规则与 core `isContentPart` 同口径（mime 以 "video/" / "audio/" 开头、durationSec 缺省或有限正数）；
 * server 不依赖 core 内部判定，两份实现靠跨包用例锁住（同一组坏形状两边都拒）。tool_reference 不收（网络边界不能替模型点亮工具）
 */
function rebuildContentParts(x: unknown): ContentPart[] | undefined {
  if (!Array.isArray(x) || x.length === 0) return undefined
  const out: ContentPart[] = []
  for (const p of x) {
    if (typeof p !== "object" || p === null) return undefined
    const part = p as {
      type?: unknown
      text?: unknown
      mime?: unknown
      data?: unknown
      durationSec?: unknown
    }
    if (part.type === "text" && typeof part.text === "string") out.push({ type: "text", text: part.text })
    else if (part.type === "image" && typeof part.mime === "string" && typeof part.data === "string")
      out.push({ type: "image", mime: part.mime, data: part.data })
    else if (
      (part.type === "video" || part.type === "audio") &&
      typeof part.mime === "string" &&
      part.mime.startsWith(`${part.type}/`) &&
      typeof part.data === "string"
    ) {
      const d = part.durationSec
      if (d !== undefined && !(typeof d === "number" && Number.isFinite(d) && d > 0)) return undefined
      out.push({
        type: part.type,
        mime: part.mime,
        data: part.data,
        ...(d !== undefined ? { durationSec: d } : {}),
      })
    } else return undefined
  }
  return out
}

/**
 * 用户消息形态的 input → 一条服务端重建的 `core.user_message` 草稿；普通路径与投递分支共用这一份。
 * 壳字段（actor / trust / provenance）一律服务端定：给了 deliveryId 才带 `provenance: { source: USER_DELIVERY_SOURCE, ref }`。
 * 草稿的 content 按白名单重建，不合规返回 undefined（调用方回 400）
 */
function userMessageDraft(
  input: NonNullable<AgentRequestBody["input"]>,
  deliveryId?: string,
): EventDraft | undefined {
  let content: ContentPart[] | undefined
  if (typeof input === "string") content = [{ type: "text", text: input }]
  else if (Array.isArray(input)) content = rebuildContentParts(input)
  else content = rebuildContentParts(((input as EventDraft).payload as { content?: unknown } | null)?.content)
  if (!content) return undefined
  return {
    type: "core.user_message",
    actor: "user",
    ...(deliveryId !== undefined ? { provenance: { source: USER_DELIVERY_SOURCE, ref: deliveryId } } : {}),
    payload: { content },
  }
}

const BAD_USER_MESSAGE = "content of user_message must be a non-empty array of content parts"

type InputCheck =
  | { ok: true; input: LoopConfig["input"] }
  | { ok: false; status: 400 | 409; error: string; message: string }

/**
 * 客户端送来的 `input` 草稿只放行两种，且壳字段（actor / trust / provenance）一律由服务端定、不信客户端给的：
 * - `core.user_message`：用户说话（actor=user）
 * - `core.tool_result`：给**客户端工具**的 pending 调用回填结果（actor=tool，name 取自 tool_call）
 * 其余类型一律 400 —— 一条伪造的 approval_decision(approved=true) 就能让 pending 调用免审批执行，伪造的 system_note 带
 * system 信任、伪造的 compaction 能把历史藏起来。循环层的 `inputDrafts` 还有第二道白名单，这里是面向网络的第一道。
 * 数组 input 在 parseBody 里已重建成内容片段，这里原样放行；草稿数组不经 HTTP（刻意不对称）。
 */
function checkInput(
  raw: AgentRequestBody["input"],
  pending: readonly ToolCallEvent[],
  tools: readonly Tool[],
): InputCheck {
  if (raw === undefined || typeof raw === "string" || Array.isArray(raw)) return { ok: true, input: raw }
  const draft = raw as EventDraft
  const payload = (draft.payload ?? {}) as Record<string, unknown>
  if (draft.type === "core.user_message") {
    const rebuilt = userMessageDraft(draft)
    if (!rebuilt) return { ok: false, status: 400, error: "bad_request", message: BAD_USER_MESSAGE }
    return { ok: true, input: rebuilt }
  }
  if (draft.type === "core.tool_result") {
    const call = pending.find((c) => c.payload.toolCallId === payload.toolCallId)
    if (!call) {
      return {
        ok: false,
        status: 409,
        error: "unknown_tool_call",
        message: `the call ${String(payload.toolCallId)} being filled in is not pending`,
      }
    }
    const tool = tools.find((t) => t.name === call.payload.name)
    if (!tool || (tool.execute && tool.side !== "client")) {
      return {
        ok: false,
        status: 400,
        error: "bad_request",
        message: `only client-side tool results can be filled in; ${call.payload.name} runs on the server`,
      }
    }
    const content = rebuildContentParts(payload.content)
    if (!content)
      return {
        ok: false,
        status: 400,
        error: "bad_request",
        message: "content of tool_result must be a non-empty array of content parts",
      }
    return {
      ok: true,
      input: {
        type: "core.tool_result",
        actor: "tool",
        parentId: call.id,
        provenance: { source: call.payload.name, ref: "client" },
        payload: {
          toolCallId: call.payload.toolCallId,
          name: call.payload.name,
          content,
          isError: payload.isError === true,
        },
      },
    }
  }
  return {
    ok: false,
    status: 400,
    error: "bad_request",
    message: `input drafts accept only core.user_message or a core.tool_result for a client-side tool, got ${String(draft.type)}`,
  }
}

/** 从 Last-Event-ID 头或 query 取 lastSeq；头是重连时浏览器自动带的、更新，优先 */
function lastSeqOf(request: Request, url: URL): number | string {
  const raw = request.headers.get("last-event-id") ?? url.searchParams.get("lastSeq")
  if (raw === null || raw === "") return 0
  const n = Number(raw)
  return isNonNegativeInt(n) ? n : "lastSeq must be a non-negative integer"
}

/**
 * 旁路观测（`HandlerOptions.onEvent`）：把 run 追加的每条事件依次交给钩子，不改事件、不挡 run。
 *
 * - **先 yield 再调钩子**：yield 出去的事件由 `ActiveRun.drive` 广播给 SSE 订阅者，钩子在那之后才跑，SSE 时延不受观测者影响。
 * - **异步返回值按事件顺序串成一条链**，但拉下一条事件不等它——观测是旁路，宿主的日志服务慢不该拖慢模型。
 *   `finally` 里等整条链结束：生成器返回之后 `drive` 才 `finish`，所以 result 帧与 `run.done` 都排在最后一次观测之后，
 *   Workers 的 `waitUntil(run.done)` 就能覆盖到观测者的收尾写入。
 * - **钩子出错一律不上抛**：throw（同步）与 reject（异步）都进同一个 catch，经 `warn` 报出，一次 run 只报一次
 *   （观测者若每条事件都失败，刷屏没有信息量）。run 本身照常跑到底。
 *
 * 为什么包在生成器外面而不是塞进 `runLoop`：runLoop 是可整个复制的普通生成器，观测本就是"消费者拿到每条 yield"这件事；
 * 进程内 `agent.run()` 的宿主 `for await` 就是观测，只有 HTTP 路径的消费者是 handler 自己，才需要这个口子。
 */
async function* observed(
  gen: AsyncGenerator<Event, RunResult>,
  hook: NonNullable<HandlerOptions["onEvent"]>,
  input: EventObserverInput,
  warn: (message: string) => void,
): AsyncGenerator<Event, RunResult> {
  let chain: Promise<void> = Promise.resolve()
  let warned = false
  const report = (event: Event, err: unknown) => {
    if (warned) return
    warned = true
    const reason = err instanceof Error ? err.message : String(err)
    warn(
      `[reins/server] The onEvent hook threw (session ${input.sessionId}, event #${event.seq} ${event.type}): ${reason}. The run is unaffected; further errors in this run are not reported.`,
    )
  }
  try {
    while (true) {
      const step = await gen.next()
      if (step.done) return step.value
      const event = step.value
      yield event
      chain = chain.then(() => hook(event, input)).catch((err: unknown) => report(event, err))
    }
  } finally {
    await chain
  }
}

interface StreamPlan {
  sessionId: string
  fromSeq: number
  log: EventLog
  /** 本流要挂的 run；无则补发完即结束 */
  run?: ActiveRun
  /** 补发完成后才开始跑（POST 路径），保证实时事件都排在补发之后 */
  begin?: () => void
  /** 本连接是 run 的发起者：断开时按 onDisconnect 处理 */
  starter: boolean
}

export function createAgentHandler(definition: AgentDefinition, options: HandlerOptions = {}): AgentHandler {
  const agent = withoutPerRunFields(definition)
  const makeEncoder: StreamEncoderFactory = options.encode ?? (() => rawEncoder)
  const deltas = options.deltas ?? true
  const onDisconnect = options.onDisconnect ?? "continue"
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const newSessionId = options.newSessionId ?? (() => uuidv7())
  const runs: RunRegistry = options.runs ?? new InMemoryRunRegistry()
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const { log } = agent
  // 补发与预校验读日志都经注册表升级（P9），与循环看到的形状一致；宿主有 ext.* 事件时在 definition 里给自己的注册表
  const registry = agent.registry ?? createCoreRegistry()
  /**
   * 本 handler 起的普通 POST run → 它的信箱（midRunInput）。WeakMap 而不挂在 ActiveRun 上：ActiveRun 是公开形状、
   * 宿主自定义登记表也会构造它，信箱只对"由这个 handler 驱动的 run"有意义；共用 `runs` 的另一个 handler 查不到，落回 409
   */
  const mailboxes = new WeakMap<ActiveRun, Mailbox>()

  /** 普通路径登记到 run 之后**同步**开箱；run 结束（收尾钩子同步跑）即关箱，之后的 POST 一定落回普通路径 */
  function openMailbox(run: ActiveRun, principal: Principal | undefined, startDeliveryId?: string): Mailbox {
    const box = new Mailbox(principal?.id, startDeliveryId)
    mailboxes.set(run, box)
    run.onFinish(() => box.close())
    return box
  }

  /**
   * 进行中投递（midRunInput）：能入箱就回 202 / 429，不能（没有本进程的 run、没有本 handler 的信箱、箱已关、run 已中止、
   * 投递者不是发起人）返回 undefined，调用方落回普通路径——那里该 409 的照旧 409、run 恰好结束的起新 run。
   *
   * **整个函数同步**：从 `runs.get` 到入箱之间有 await 的话，run 可能在空隙里结束，消息就入了一个已关的箱、回了 202 却必丢。
   */
  function deliver(
    sessionId: string,
    deliveryId: string,
    draft: EventDraft,
    principal: Principal | undefined,
  ): Response | undefined {
    const active = runs.get(sessionId)
    if (active === undefined) return undefined
    const box = mailboxes.get(active)
    if (box === undefined || box.closed || active.controller.signal.aborted) return undefined
    // 发起人校验：run 的 principal 起步时定死、工具拿到的是它；别的主事人的话不能以发起人身份被执行（匿名两边都是 undefined）
    if (box.starterId !== principal?.id) return undefined
    if (box.offer(deliveryId, draft) === "full") {
      return json(
        429,
        {
          error: "mailbox_full",
          message: `the run in session ${sessionId} already holds ${MAILBOX_LIMIT} undelivered messages; retry after some are written`,
        },
        { [SESSION_HEADER]: sessionId },
      )
    }
    const queued: QueuedResponse = { status: "queued", sessionId, deliveryId }
    return json(202, queued, { [SESSION_HEADER]: sessionId })
  }

  /** 组装 SSE 响应。补发 + （可选）实时推，全部在 ReadableStream 内部异步进行，Response 立刻返回 */
  function openStream(plan: StreamPlan): Response {
    const encode: StreamEncoder = makeEncoder()
    const textEncoder = new TextEncoder()
    let closed = false
    let begun = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let sub: Channel<RunSignal> | undefined

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (text: string) => {
          if (closed) return
          controller.enqueue(textEncoder.encode(text))
        }
        const emit = (item: StreamItem) => {
          for (const frame of encode(item)) write(encodeSseFrame(frame))
        }
        const close = () => {
          if (closed) return
          closed = true
          cleanup()
          try {
            controller.close()
          } catch {
            // 客户端已断开时 close 会抛，忽略
          }
        }
        const cleanup = () => {
          if (heartbeat !== undefined) clearInterval(heartbeat)
          if (sub !== undefined && plan.run !== undefined) plan.run.unsubscribe(sub)
        }
        if (heartbeatMs > 0) heartbeat = setInterval(() => write(SSE_HEARTBEAT), heartbeatMs)

        const pump = async () => {
          // 先订阅再补发：补发期间 run 推出的事件先攒在队列里，补发完按 seq 去重
          if (plan.run !== undefined) sub = plan.run.subscribe()
          // 客户端报的 lastSeq 若超过日志末尾（换了会话、存储被清），钳到末尾：否则之后的实时事件会被当成"已补发过"静默丢掉
          const tailSeq = (await log.tail(plan.sessionId, 1))[0]?.seq ?? 0
          const fromSeq = Math.min(plan.fromSeq, tailSeq + 1)
          emit({ kind: "start", sessionId: plan.sessionId, fromSeq, live: plan.run !== undefined })

          let maxSeq = fromSeq - 1
          for await (const e of readEvents(log, plan.sessionId, { registry, fromSeq })) {
            if (closed) break
            emit({ kind: "event", event: e, replay: true })
            maxSeq = e.seq
          }
          if (plan.run === undefined || sub === undefined) {
            emit({ kind: "end", sessionId: plan.sessionId, lastSeq: maxSeq })
            close()
            return
          }
          // run 是 POST 到达时就决定要跑的：补发期间客户端走了也照样开跑（onDisconnect 决定是否随即中止）
          begun = true
          plan.begin?.()
          if (closed) return

          const forward = (sig: RunSignal): boolean => {
            switch (sig.kind) {
              case "event":
                // 补发时已经从日志读到的事件不再推第二遍
                if (sig.event.seq > maxSeq) emit({ kind: "event", event: sig.event, replay: false })
                return true
              case "delta":
                emit({ kind: "delta", delta: sig.delta })
                return true
              case "result":
                emit({ kind: "result", result: sig.result })
                return false
              case "error":
                emit({ kind: "error", code: sig.code, message: sig.message })
                return false
            }
          }
          // 补发期间攒下的：事件去重后推，增量丢弃（它们所属的内容块要么已在补发里完整出现，要么不久后会完整到达）
          for (const sig of sub.drain()) {
            if (sig.kind === "delta") continue
            if (!forward(sig)) {
              close()
              return
            }
          }
          for await (const sig of sub) {
            if (closed) return
            if (!forward(sig)) break
          }
          close()
        }

        pump().catch((err: unknown) => {
          // 补发读日志失败等：告知客户端后关闭。run 已开始则继续在后台跑；还没开始的名额要还回去，否则会话永久 409
          const code =
            typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
              ? err.code
              : "internal"
          const message = err instanceof Error ? err.message : String(err)
          emit({ kind: "error", code, message })
          close()
          if (plan.starter && plan.run !== undefined && !begun) plan.run.abandon(code, message)
        })
      },
      cancel() {
        // 客户端断开
        closed = true
        if (heartbeat !== undefined) clearInterval(heartbeat)
        if (sub !== undefined && plan.run !== undefined) plan.run.unsubscribe(sub)
        // 发起者断开：abort 模式下中止 run（还没开跑也没关系，runLoop 拿到的是已中止的 signal → paused(host)）
        if (plan.starter && plan.run !== undefined && onDisconnect === "abort") plan.run.controller.abort()
      },
    })

    return new Response(body, { status: 200, headers: { ...SSE_HEADERS, [SESSION_HEADER]: plan.sessionId } })
  }

  /**
   * 跑一次会话级鉴权。返回 Response 表示"到此为止，把它回给客户端"；返回 undefined 表示放行。
   *
   * fail-closed：**只有钩子显式返回 true 才放行**，false 与 undefined（宿主漏写 return）一律拒。
   * 拒绝一律 404 而不是 403：403 等于确认"这条会话存在，只是你不能看"（与 blob 授权同一规则）。
   */
  async function denyBySessionAuthz(input: SessionAuthzInput): Promise<Response | undefined> {
    if (options.authorizeSession === undefined) return undefined
    let allowed: boolean | undefined
    try {
      allowed = await options.authorizeSession(input)
    } catch (err) {
      if (err instanceof Response) return err
      throw err
    }
    if (allowed !== true) return json(404, { error: "not_found", message: "session not found" })
    return undefined
  }

  async function handleGet(request: Request, url: URL, principal: Principal | undefined): Promise<Response> {
    const sessionId = url.searchParams.get("sessionId")
    if (sessionId === null || sessionId === "")
      return json(400, { error: "bad_request", message: "missing sessionId" })
    // query 来的 sessionId 同样是客户端输入，越界字符会让回写响应头时抛 TypeError
    if (!isValidSessionId(sessionId))
      return json(400, {
        error: "bad_request",
        message: "sessionId must be a non-empty printable ASCII string with no spaces",
      })
    // 读日志之前先问归属：GET 拿到 sessionId 就能补发整条时间线，这里是唯一的关口
    const denied = await denyBySessionAuthz({
      sessionId,
      principal,
      request,
      method: "GET",
      isNew: false,
    })
    if (denied !== undefined) return denied
    const lastSeq = lastSeqOf(request, url)
    if (typeof lastSeq === "string") return json(400, { error: "bad_request", message: lastSeq })
    const run = runs.get(sessionId)
    return openStream({
      sessionId,
      fromSeq: lastSeq + 1,
      log,
      ...(run !== undefined ? { run } : {}),
      starter: false,
    })
  }

  async function handlePost(
    request: Request,
    ctx: HandlerContext | undefined,
    principal: Principal | undefined,
  ): Promise<Response> {
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      return json(400, { error: "bad_request", message: "request body is not valid JSON" })
    }
    const parsed = parseBody(raw)
    if (!parsed.ok) return json(400, { error: "bad_request", message: parsed.error })
    const body = parsed.body
    if (body.stop === true && body.sessionId !== undefined)
      return handleStop(request, ctx, principal, body.sessionId)
    const sessionId = body.sessionId ?? newSessionId()
    // 归属判定放在 readTimeline / validateResume 之前：那些已经在读这条会话的日志了
    const denied = await denyBySessionAuthz({
      sessionId,
      principal,
      request,
      method: "POST",
      isNew: body.sessionId === undefined,
    })
    if (denied !== undefined) return denied

    // ---- 进行中投递（midRunInput）：只带用户消息、不带 resume / decisions 的续聊才可能入箱 ----
    // 鉴权、JSON 解析、草稿重建都在这之前做完；deliver 内部从 runs.get 到入箱全同步。内容不合规先 400（与普通路径同一顺序）
    if (
      options.midRunInput === true &&
      body.sessionId !== undefined &&
      body.resume === undefined &&
      body.decisions === undefined &&
      isUserMessageInput(body.input)
    ) {
      const deliveryId = body.deliveryId ?? uuidv7()
      const draft = userMessageDraft(body.input, deliveryId)
      if (!draft) return json(400, { error: "bad_request", message: BAD_USER_MESSAGE })
      const delivered = deliver(sessionId, deliveryId, draft, principal)
      if (delivered !== undefined) return delivered
    }

    const fromSeq = (body.lastSeq ?? 0) + 1
    const inputIsDraft =
      body.input !== undefined && typeof body.input !== "string" && !Array.isArray(body.input)

    // 恢复参数与事件草稿先在这里校验一遍，能给出 4xx 而不是 200 + error 帧；循环内部还会再校验一次（fail-closed 不靠这里）
    let input: LoopConfig["input"] = body.input
    if (
      body.resume !== undefined ||
      (body.decisions !== undefined && body.decisions.length > 0) ||
      inputIsDraft
    ) {
      try {
        const timeline = await readTimeline(log, sessionId, { registry })
        const contributions = await resolveSocketContributions(agent)
        if (body.resume !== undefined) {
          await validateResume({
            state: body.resume,
            sessionId,
            timeline,
            // 与 runLoop 起步同一份算法：并入各 Socket 的静态贡献（否则装了 compact / memory 等模块就会误判配置漂移）
            configHash: await computeConfigHash({ model: agent.model, ...contributions }),
            // D4：与 runLoop 同口径——只比模型与 pending 调用的工具定义，取基础工具表
            model: agent.model,
            tools: contributions.tools,
            ...(agent.secret !== undefined ? { secret: agent.secret } : {}),
            ...(agent.allowConfigDrift !== undefined ? { allowConfigDrift: agent.allowConfigDrift } : {}),
          })
        }
        const pending = pendingToolCalls(timeline)
        const pendingIds = new Set(pending.map((c) => c.payload.toolCallId))
        // 与 runLoop 同一口径（§10.1）：只有本会话的结论才对照本会话的 pending；带别的 sessionId 的是给子代理会话的，
        // 这里不校验、原样下传，由 asTool 在子会话里校验。两处一分叉，经 HTTP 续跑子代理审批就会 409（2026-09-10 审查修）
        for (const d of body.decisions ?? []) {
          if (d.sessionId !== undefined && d.sessionId !== sessionId) continue
          if (!pendingIds.has(d.toolCallId)) {
            throw new RunStateError(
              "unknown_tool_call",
              `approval decision refers to call ${d.toolCallId}, which is not pending`,
              {
                toolCallId: d.toolCallId,
              },
            )
          }
        }
        const checked = checkInput(body.input, pending, contributions.tools)
        if (!checked.ok) return json(checked.status, { error: checked.error, message: checked.message })
        input = checked.input
      } catch (err) {
        if (err instanceof RunStateError) return json(409, { error: err.code, message: err.message })
        throw err
      }
    }
    // 带 deliveryId 的普通路径：起步 input 换成带 provenance 的重建草稿，客户端对每条消息只用一种送达判据。
    // 不带时 input 原样不动，日志与此前逐字相同。parseBody 已保证此时 input 是用户消息形态
    if (body.deliveryId !== undefined && body.input !== undefined) {
      const draft = userMessageDraft(body.input, body.deliveryId)
      if (!draft) return json(400, { error: "bad_request", message: BAD_USER_MESSAGE })
      input = draft
    }

    let run: ActiveRun
    try {
      // 租约登记表在这里问一次存储；acquire 时存储不可用照常抛（不知道能不能跑就不跑）
      run = await runs.create(sessionId)
    } catch (err) {
      if (err instanceof RunConflictError) {
        return json(409, { error: err.code, message: err.message }, { [SESSION_HEADER]: sessionId })
      }
      throw err
    }
    // 客户端断开后 run 继续；Workers 需要 waitUntil 才不会在响应结束时被回收
    ctx?.waitUntil?.(run.done)
    // 登记与开箱之间隔着 runs.create 的 await：那个空隙里到达的投递查不到信箱、落回普通路径 409（安全，README 不承诺）。
    // 补发期间、begin 之前到达的在第 1 轮拉到，排在起步 input 之后
    const mailbox = options.midRunInput === true ? openMailbox(run, principal, body.deliveryId) : undefined

    const begin = () => {
      const gen = runLoop({
        ...agent,
        sessionId,
        signal: run.controller.signal,
        ...(input !== undefined ? { input } : {}),
        ...(body.resume !== undefined ? { resume: body.resume } : {}),
        ...(body.decisions !== undefined ? { decisions: body.decisions } : {}),
        ...(principal !== undefined ? { principal } : {}),
        ...(deltas ? { onDelta: (delta) => run.broadcast({ kind: "delta", delta }) } : {}),
        // 快照不删；写进时间线由 claiming 认领（取出即删会让"拉完发现已中止"的消息凭空消失）
        ...(mailbox !== undefined ? { pullInput: () => mailbox.snapshot() } : {}),
      })
      drive(run, mailbox !== undefined ? claiming(gen, mailbox) : gen, { sessionId, principal, request })
    }
    return openStream({ sessionId, fromSeq, log, run, begin, starter: true })
  }

  /** 驱动 run 消费生成器；旁路观测只包 live 的 run，补发走 readEvents 不经这里 */
  function drive(run: ActiveRun, gen: AsyncGenerator<Event, RunResult>, input: EventObserverInput): void {
    const onEvent = options.onEvent
    void run.drive(onEvent !== undefined ? observed(gen, onEvent, input, warn) : gen)
  }

  /**
   * 停止请求（D3）：不等 run 结束，立即回 JSON。正在跑的 run 以 RunStop 中止（循环在暂停时把 pending 收尾成"没执行"等结果）；
   * 空闲但有 pending 的会话起一个 signal 预先停止的 run，它在一轮开头就进入暂停、只收尾不问模型——没有流驱动它，
   * 所以这里自己 drive，并 waitUntil(run.done)，否则 Workers 上收尾 run 可能被回收
   */
  async function handleStop(
    request: Request,
    ctx: HandlerContext | undefined,
    principal: Principal | undefined,
    sessionId: string,
  ): Promise<Response> {
    const denied = await denyBySessionAuthz({ sessionId, principal, request, method: "STOP", isNew: false })
    if (denied !== undefined) return denied
    const stopping: StopResponse = { status: "stopping", sessionId }
    const active = runs.get(sessionId)
    if (active !== undefined) {
      active.controller.abort(new RunStop())
      return json(200, stopping)
    }
    const timeline = await readTimeline(log, sessionId, { registry })
    if (pendingToolCalls(timeline).length === 0) {
      const idle: StopResponse = { status: "idle", sessionId }
      return json(200, idle)
    }
    const controller = new AbortController()
    controller.abort(new RunStop())
    let run: ActiveRun
    try {
      run = await runs.create(sessionId, controller)
    } catch (err) {
      if (err instanceof RunConflictError) {
        return json(409, { error: err.code, message: err.message }, { [SESSION_HEADER]: sessionId })
      }
      throw err
    }
    ctx?.waitUntil?.(run.done)
    drive(
      run,
      runLoop({
        ...agent,
        sessionId,
        signal: controller.signal,
        ...(principal !== undefined ? { principal } : {}),
      }),
      { sessionId, principal, request },
    )
    return json(200, stopping)
  }

  return async (request, ctx) => {
    let principal: Principal | undefined
    try {
      principal = await options.principal?.(request)
    } catch (err) {
      if (err instanceof Response) return err
      throw err
    }
    const url = new URL(request.url)
    if (request.method === "GET") return handleGet(request, url, principal)
    if (request.method === "POST") return handlePost(request, ctx, principal)
    return json(
      405,
      { error: "method_not_allowed", message: "only GET and POST are accepted" },
      { allow: "GET, POST" },
    )
  }
}

/**
 * 运行时剥掉每次 run 才该有的 `pullInput`：类型上 `AgentDefinition` 已排除它，但变量传参、`as` 断言与 JS 宿主挡不住；
 * 漏进来的话每个 HTTP run 与停止收尾 run 都会拿进程内宿主的回调去拉队列（fail-closed）
 */
function withoutPerRunFields(definition: AgentDefinition): AgentDefinition {
  const { pullInput: _perRun, ...rest } = definition as AgentDefinition & { pullInput?: unknown }
  return rest
}
