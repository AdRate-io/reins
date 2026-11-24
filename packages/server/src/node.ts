/**
 * @reinsjs/server/node —— 把 Web 标准 handler 挂到 node:http 上的几十行适配。
 *
 * 只在这个子路径出现 `node:*`；主入口保持纯 Web 标准。Hono / TanStack Start / Fastify 等框架
 * 自带同类适配，用它们的即可；这里是给"只想 node server.ts 跑起来"的人。
 * 客户端断开时取消响应流（handler 据此决定 run 是继续还是中止）。断开监听在调 handler 之前就挂上：
 * `close` 只发一次，handler 内部鉴权 / 读日志 / 抢租约的 await 期间断开的话，事后再挂就永远收不到，
 * `onDisconnect: "abort"` 失效、run 跑完照花钱，心跳也一直挂在死连接上。
 *
 * handler 按设计会把部分错误抛给宿主（租约存储不可用、预校验读日志失败、principal 抛非 Response 的错），
 * 本适配器就是库自带的宿主，必须接住：node:http 不处理 listener 返回的 promise，漏接即未处理的 rejection，
 * Node 缺省直接退出进程，所有会话上在跑的 run 与 SSE 一起断。
 */
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AgentHandler, HandlerContext } from "./types.js"

export type NodeListener = (req: IncomingMessage, res: ServerResponse) => Promise<void>

export function nodeListener(handler: AgentHandler, ctx?: HandlerContext): NodeListener {
  return async (req, res) => {
    // 连接关闭（客户端断开，或响应正常写完）就 abort；正常写完后再取消已读完的流是空操作
    const gone = new AbortController()
    res.once("close", () => gone.abort())
    try {
      const request = await toRequest(req)
      let response: Response
      try {
        response = await handler(request, ctx)
      } catch (err) {
        // 抛出的 Response 是 principal / authorizeSession 的拒绝，原样写回；其余是宿主侧故障
        if (!(err instanceof Response)) throw err
        response = err
      }
      await writeResponse(response, res, gone.signal)
    } catch (err) {
      fail(res, err)
    }
  }
}

/** node:http 请求 → Web 标准 Request（读完整个 body） */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v)
    else if (Array.isArray(v)) for (const item of v) headers.append(k, item)
  }
  const method = req.method ?? "GET"
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
  })
}

/** 把 Response 写进 ServerResponse；客户端断开（含 handler 返回之前就断开）时取消响应流 */
async function writeResponse(response: Response, res: ServerResponse, gone: AbortSignal): Promise<void> {
  if (gone.aborted) {
    await response.body?.cancel().catch(() => {})
    return
  }
  res.writeHead(response.status, Object.fromEntries(response.headers))
  const reader = response.body?.getReader()
  if (!reader) {
    res.end()
    return
  }
  gone.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true })
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(value)
  }
  res.end()
}

/**
 * 兜底：响应头还没发就回 500（细节不外泄，完整错误进 console.error；要接自己的日志就在 handler 外再包一层）；
 * 已经开始写流（SSE 中途读失败）就只能销毁连接，让客户端按断线重连补发。
 */
function fail(res: ServerResponse, err: unknown): void {
  console.error("[reins] nodeListener: request failed", err)
  if (res.headersSent) {
    res.destroy()
    return
  }
  if (res.destroyed) return
  res.writeHead(500, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: "internal_error", message: "the server failed to handle the request" }))
}
