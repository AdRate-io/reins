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
  computeConfigHash,
  type Event,
  type EventLog,
  type Principal,
  pendingToolCalls,
  RunStateError,
  runLoop,
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
  StreamEncoder,
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

/** 请求体只做壳校验；resume 的形状与签名交给 core 的 validateResume，input 的内容交给循环 */
function parseBody(raw: unknown): { ok: true; body: AgentRequestBody } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "请求体必须是 JSON 对象" }
  }
  const b = raw as Record<string, unknown>
  if (b.sessionId !== undefined && (typeof b.sessionId !== "string" || b.sessionId.length === 0)) {
    return { ok: false, error: "sessionId 必须是非空字符串" }
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
          typeof d.by === "string",
      )
    if (!okDecisions) return { ok: false, error: "decisions 每项必须含 toolCallId / approved / by" }
  }
  if (b.resume !== undefined && (typeof b.resume !== "object" || b.resume === null)) {
    return { ok: false, error: "resume 必须是对象" }
  }
  return { ok: true, body: b as AgentRequestBody }
}

/** 从 Last-Event-ID 头或 query 取 lastSeq；头是重连时浏览器自动带的、更新，优先 */
function lastSeqOf(request: Request, url: URL): number | string {
  const raw = request.headers.get("last-event-id") ?? url.searchParams.get("lastSeq")
  if (raw === null || raw === "") return 0
  const n = Number(raw)
  return isNonNegativeInt(n) ? n : "lastSeq 必须是非负整数"
}

async function collect(iter: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = []
  for await (const e of iter) out.push(e)
  return out
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
  const encode: StreamEncoder = options.encode ?? rawEncoder
  const deltas = options.deltas ?? true
  const onDisconnect = options.onDisconnect ?? "continue"
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const newSessionId = options.newSessionId ?? (() => uuidv7())
  const runs = options.runs ?? new RunRegistry()
  const { log } = agent

  /** 组装 SSE 响应。补发 + （可选）实时推，全部在 ReadableStream 内部异步进行，Response 立刻返回 */
  function openStream(plan: StreamPlan): Response {
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
          emit({
            kind: "start",
            sessionId: plan.sessionId,
            fromSeq: plan.fromSeq,
            live: plan.run !== undefined,
          })
          // 先订阅再补发：补发期间 run 推出的事件先攒在队列里，补发完按 seq 去重
          if (plan.run !== undefined) sub = plan.run.subscribe()

          let maxSeq = plan.fromSeq - 1
          for await (const e of log.read(plan.sessionId, { fromSeq: plan.fromSeq })) {
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

  async function handleGet(request: Request, url: URL): Promise<Response> {
    const sessionId = url.searchParams.get("sessionId")
    if (sessionId === null || sessionId === "")
      return json(400, { error: "bad_request", message: "缺少 sessionId" })
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
    const fromSeq = (body.lastSeq ?? 0) + 1

    // 恢复参数先在这里校验一遍，能给出 409 而不是 200 + error 帧；循环内部还会再校验一次（fail-closed 不靠这里）
    if (body.resume !== undefined || (body.decisions !== undefined && body.decisions.length > 0)) {
      try {
        const timeline = await collect(log.read(sessionId))
        if (body.resume !== undefined) {
          await validateResume({
            state: body.resume,
            sessionId,
            timeline,
            configHash: await computeConfigHash({
              model: agent.model,
              tools: agent.tools ?? [],
              ...(agent.systemPrompt !== undefined ? { systemPrompt: agent.systemPrompt } : {}),
            }),
            ...(agent.secret !== undefined ? { secret: agent.secret } : {}),
            ...(agent.allowConfigDrift !== undefined ? { allowConfigDrift: agent.allowConfigDrift } : {}),
          })
        }
        const pending = new Set(pendingToolCalls(timeline).map((c) => c.payload.toolCallId))
        for (const d of body.decisions ?? []) {
          if (!pending.has(d.toolCallId)) {
            throw new RunStateError("unknown_tool_call", `审批结论指向的调用 ${d.toolCallId} 并不在等待中`, {
              toolCallId: d.toolCallId,
            })
          }
        }
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
        ...(body.input !== undefined ? { input: body.input } : {}),
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
    if (request.method === "GET") return handleGet(request, url)
    if (request.method === "POST") return handlePost(request, ctx, principal)
    return json(405, { error: "method_not_allowed", message: "只接受 GET 与 POST" }, { allow: "GET, POST" })
  }
}
