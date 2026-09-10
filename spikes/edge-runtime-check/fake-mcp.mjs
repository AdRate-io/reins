/**
 * 假 MCP 服务器（Streamable HTTP）—— 跑在 Node 里，给 workerd 里的 @reins/tools-mcp dist 打。
 * 用官方 @modelcontextprotocol/server 的 Web 标准传输，node:http 只做 IncomingMessage ⇄ Request/Response 的搬运。
 * 依赖从 packages/tools-mcp 的 node_modules 解析（spikes 不在 workspace 里）。
 */
import { createServer } from "node:http"
import { createRequire } from "node:module"

const require = createRequire(new URL("../../packages/tools-mcp/package.json", import.meta.url))
const { McpServer, createMcpHandler } = require("@modelcontextprotocol/server")
const { z } = require("zod")

/**
 * 每个请求 / 会话由工厂造一个 McpServer 实例（`createMcpHandler` 的约定）。
 * 踩过的坑：一个 `WebStandardStreamableHTTPServerTransport` 只服务一个会话，第二个客户端 initialize 直接 400
 * "Server already initialized"——workerd 里的 tools-mcp 断了重建就是"第二个客户端"。见 docs/踩坑记录.md 2026-09-10。
 */
function makeServer() {
  const server = new McpServer({ name: "edge-fake-mcp", version: "0.0.0" })
  server.registerTool(
    "echo",
    { description: "echo", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
  )
  server.registerTool(
    "drop_table",
    {
      description: "destructive",
      inputSchema: { table: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ table }) => ({ content: [{ type: "text", text: `dropped ${table}` }] }),
  )
  return server
}
const handler = createMcpHandler(() => makeServer())

const port = Number(process.env.MCP_PORT ?? 8792)
createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v)
    else if (Array.isArray(v)) for (const item of v) headers.append(k, item)
  }
  const method = req.method ?? "GET"
  const request = new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
  })
  const response = await handler.fetch(request)
  res.writeHead(response.status, Object.fromEntries(response.headers))
  const reader = response.body?.getReader()
  if (!reader) return res.end()
  res.on("close", () => void reader.cancel().catch(() => {}))
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(value)
  }
  res.end()
}).listen(port, "127.0.0.1", () => console.log("MCP_READY"))
