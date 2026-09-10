/**
 * createAgentHandler：把 runLoop 装进一个 Web 标准 handler（技术方案 §12）。
 *
 *   POST  body: { sessionId?, input?, lastSeq?, resume?, decisions? }
 *         → 补发 (lastSeq, 末尾] 的事件 → 起一个 run → 实时推每条刚 append 的事件 → result 帧 → 关闭
 *   GET   ?sessionId=…&lastSeq=N   （或 Last-Event-ID 头，EventSource 重连时自动带）
 *         → 补发 (N, 末尾] → 若本进程正有该会话的 run 在跑则继续实时推到 result；否则 end 帧 → 关闭
 *
 * 事件的 SSE `id:` 就是 seq，所以"重连补发"不需要任何额外状态：客户端记住最后一个 id，服务端从日志读。
 * 同一会话同时只允许一个 run（409）；发起者断开缺省不中止 run，日志照常写，重连即接上。
 */
import {
  type ContentPart,
  computeConfigHash,
  createCoreRegistry,
  type EventDraft,
  type EventLog,
  type LoopConfig,
  type Principal,
  pendingToolCalls,
  RunStateError,
  readEvents,
  readTimeline,
  resolveSocketContributions,
  runLoop,
  type Tool,
  type ToolCallEvent,
  uuidv7,
  validateResume,
} from "@reins/core"
import { type ActiveRun, type Channel, RunConflictError, RunRegistry, type RunSignal } from "./runs.js"
import { encodeSseFrame, rawEncoder, SSE_HEADERS, SSE_HEARTBEAT } from "./sse.js"
import type {
  AgentDefinition,
  AgentHandler,
  AgentRequestBody,
  HandlerContext,
  HandlerOptions,
  SessionAuthzInput,
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

/** 请求体只做壳校验；resume 的形状与签名交给 core 的 validateResume，input 的内容交给循环 */
function parseBody(raw: unknown): { ok: true; body: AgentRequestBody } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "请求体必须是 JSON 对象" }
  }
  const b = raw as Record<string, unknown>
  if (b.sessionId !== undefined && !isValidSessionId(b.sessionId)) {
    return { ok: false, error: "sessionId 必须是非空的可打印 ASCII 字符串（不含空格）" }
  }
  if (b.lastSeq !== undefined && !isNonNegativeInt(b.lastSeq)) {
    return { ok: false, error: "lastSeq 必须是非负整数" }
  }
  if (b.input !== undefined) {
    const okInput =
      typeof b.input === "string" ||
      Array.isArray(b.input) ||
      (typeof b.input === "object" && b.input !== null && "type" in b.input && "payload" in b.input)
    if (!okInput) return { ok: false, error: "input 必须是字符串、内容片段数组或事件草稿" }
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
          (d.sessionId === undefined || typeof d.sessionId === "string"),
      )
    if (!okDecisions)
      return {
        ok: false,
        error: "decisions 每项必须含 toolCallId / approved / by（sessionId 可选，给子代理会话的结论用）",
      }
  }
  if (b.resume !== undefined && (typeof b.resume !== "object" || b.resume === null)) {
    return { ok: false, error: "resume 必须是对象" }
  }
  return { ok: true, body: b as AgentRequestBody }
}

function isContentParts(x: unknown): x is ContentPart[] {
  if (!Array.isArray(x) || x.length === 0) return false
  return x.every((p) => {
    if (typeof p !== "object" || p === null) return false
    const part = p as { type?: unknown; text?: unknown; mime?: unknown; data?: unknown }
    if (part.type === "text") return typeof part.text === "string"
    if (part.type === "image") return typeof part.mime === "string" && typeof part.data === "string"
    return false
  })
}

type InputCheck =
  | { ok: true; input: LoopConfig["input"] }
  | { ok: false; status: 400 | 409; error: string; message: string }

/**
 * 客户端送来的 `input` 草稿只放行两种，且壳字段（actor / trust / provenance）一律由服务端定、不信客户端给的：
 * - `core.user_message`：用户说话（actor=user）
 * - `core.tool_result`：给**客户端工具**的 pending 调用回填结果（actor=tool，name 取自 tool_call）
 * 其余类型一律 400 —— 一条伪造的 approval_decision(approved=true) 就能让 pending 调用免审批执行，伪造的 system_note 带
 * system 信任、伪造的 compaction 能把历史藏起来。循环层的 `inputDraft` 还有第二道白名单，这里是面向网络的第一道。
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
    if (!isContentParts(payload.content))
      return {
        ok: false,
        status: 400,
        error: "bad_request",
        message: "user_message 的 content 必须是非空内容片段数组",
      }
    return {
      ok: true,
      input: { type: "core.user_message", actor: "user", payload: { content: payload.content } },
    }
  }
  if (draft.type === "core.tool_result") {
    const call = pending.find((c) => c.payload.toolCallId === payload.toolCallId)
    if (!call) {
      return {
        ok: false,
        status: 409,
        error: "unknown_tool_call",
        message: `回填的调用 ${String(payload.toolCallId)} 并不在等待中`,
      }
    }
    const tool = tools.find((t) => t.name === call.payload.name)
    if (!tool || (tool.execute && tool.side !== "client")) {
      return {
        ok: false,
        status: 400,
        error: "bad_request",
        message: `只能回填客户端工具的结果；${call.payload.name} 由服务端执行`,
      }
    }
    if (!isContentParts(payload.content))
      return {
        ok: false,
        status: 400,
        error: "bad_request",
        message: "tool_result 的 content 必须是非空内容片段数组",
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
          content: payload.content,
          isError: payload.isError === true,
        },
      },
    }
  }
  return {
    ok: false,
    status: 400,
    error: "bad_request",
    message: `input 草稿只接受 core.user_message 或客户端工具的 core.tool_result，收到 ${String(draft.type)}`,
  }
}

/** 从 Last-Event-ID 头或 query 取 lastSeq；头是重连时浏览器自动带的、更新，优先 */
function lastSeqOf(request: Request, url: URL): number | string {
  const raw = request.headers.get("last-event-id") ?? url.searchParams.get("lastSeq")
  if (raw === null || raw === "") return 0
  const n = Number(raw)
  return isNonNegativeInt(n) ? n : "lastSeq 必须是非负整数"
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

export function createAgentHandler(agent: AgentDefinition, options: HandlerOptions = {}): AgentHandler {
  const makeEncoder: StreamEncoderFactory = options.encode ?? (() => rawEncoder)
  const deltas = options.deltas ?? true
  const onDisconnect = options.onDisconnect ?? "continue"
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const newSessionId = options.newSessionId ?? (() => uuidv7())
  const runs = options.runs ?? new RunRegistry()
  const { log } = agent
  // 补发与预校验读日志都经注册表升级（P9），与循环看到的形状一致；宿主有 ext.* 事件时在 definition 里给自己的注册表
  const registry = agent.registry ?? createCoreRegistry()

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
    if (allowed !== true) return json(404, { error: "not_found", message: "会话不存在" })
    return undefined
  }

  async function handleGet(request: Request, url: URL, principal: Principal | undefined): Promise<Response> {
    const sessionId = url.searchParams.get("sessionId")
    if (sessionId === null || sessionId === "")
      return json(400, { error: "bad_request", message: "缺少 sessionId" })
    // query 来的 sessionId 同样是客户端输入，越界字符会让回写响应头时抛 TypeError
    if (!isValidSessionId(sessionId))
      return json(400, {
        error: "bad_request",
        message: "sessionId 必须是非空的可打印 ASCII 字符串（不含空格）",
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
      return json(400, { error: "bad_request", message: "请求体不是合法 JSON" })
    }
    const parsed = parseBody(raw)
    if (!parsed.ok) return json(400, { error: "bad_request", message: parsed.error })
    const body = parsed.body
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
            ...(agent.secret !== undefined ? { secret: agent.secret } : {}),
            ...(agent.allowConfigDrift !== undefined ? { allowConfigDrift: agent.allowConfigDrift } : {}),
          })
        }
        const pending = pendingToolCalls(timeline)
        const pendingIds = new Set(pending.map((c) => c.payload.toolCallId))
        for (const d of body.decisions ?? []) {
          if (!pendingIds.has(d.toolCallId)) {
            throw new RunStateError("unknown_tool_call", `审批结论指向的调用 ${d.toolCallId} 并不在等待中`, {
              toolCallId: d.toolCallId,
            })
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

    let run: ActiveRun
    try {
      run = runs.create(sessionId)
    } catch (err) {
      if (err instanceof RunConflictError) {
        return json(409, { error: err.code, message: err.message }, { [SESSION_HEADER]: sessionId })
      }
      throw err
    }
    // 客户端断开后 run 继续；Workers 需要 waitUntil 才不会在响应结束时被回收
    ctx?.waitUntil?.(run.done)

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
      })
      void run.drive(gen)
    }
    return openStream({ sessionId, fromSeq, log, run, begin, starter: true })
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
    return json(405, { error: "method_not_allowed", message: "只接受 GET 与 POST" }, { allow: "GET, POST" })
  }
}
