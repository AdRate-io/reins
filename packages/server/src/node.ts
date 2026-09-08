/**
 * @reins/server/node —— 把 Web 标准 handler 挂到 node:http 上的十几行适配。
 *
 * 只在这个子路径出现 `node:*`；主入口保持纯 Web 标准。Hono / TanStack Start / Fastify 等框架
 * 自带同类适配，用它们的即可；这里是给"只想 node server.ts 跑起来"的人。
 * 客户端断开时取消响应流（handler 据此决定 run 是继续还是中止）。
 */
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AgentHandler, HandlerContext } from "./types.js"

export type NodeListener = (req: IncomingMessage, res: ServerResponse) => Promise<void>

export function nodeListener(handler: AgentHandler, ctx?: HandlerContext): NodeListener {
  return async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v)
      else if (Array.isArray(v)) for (const item of v) headers.append(k, item)
    }
    const method = req.method ?? "GET"
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
    })
    const response = await handler(request, ctx)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    const reader = response.body?.getReader()
    if (!reader) {
      res.end()
      return
    }
    res.on("close", () => void reader.cancel().catch(() => {}))
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
    res.end()
  }
}
