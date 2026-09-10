/**
 * 示例 MCP 服务器：一个小库存系统，Streamable HTTP，跑在 node:http 上。
 *
 *   node examples/mcp/server.ts            # 监听 mcp.config.json 里那个端口（缺省 8765）
 *
 * 三个工具刻意带不同注解，看 reins 怎么把注解翻成风险与审批缺省：
 * - list_inventory   readOnlyHint      → risk low，approval 缺省放行
 * - get_item         （无注解）         → risk medium，approval 缺省先问人（byRisk）
 * - restock          destructiveHint   → risk high，needsApproval 缺省 true
 * 服务器完全不知道 reins 的存在（P3）：spill / approval / budget 都在 reins 这一侧生效。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

interface Item {
  sku: string
  name: string
  stock: number
  reorderAt: number
}

const INITIAL: Item[] = [
  { sku: "A-100", name: "Ceramic mug", stock: 42, reorderAt: 10 },
  { sku: "A-101", name: "Steel bottle", stock: 3, reorderAt: 10 },
  { sku: "B-200", name: "Notebook (dotted)", stock: 0, reorderAt: 20 },
  { sku: "B-201", name: "Gel pen, black", stock: 120, reorderAt: 50 },
  { sku: "C-300", name: "Desk lamp", stock: 4, reorderAt: 5 },
]

/**
 * 造一个 McpServer 实例。`createMcpHandler` 每个请求 / 会话都会调一次工厂（Streamable HTTP 2026-07 修订是按请求的），
 * 所以库存状态 `items` 必须放在工厂外面共享 —— 放在 server 实例里会每个请求各一份。
 * 踩过的坑：一个 `WebStandardStreamableHTTPServerTransport` 实例只服务**一个**会话，第二个客户端来 initialize 就 400
 * "Server already initialized"；多客户端 / 重连的服务器要用 createMcpHandler（见 docs/踩坑记录.md）。
 */
export function createInventoryServer(items: Item[]): { server: McpServer; items: Item[] } {
  const server = new McpServer({ name: "inventory", version: "0.1.0" })

  server.registerTool(
    "list_inventory",
    {
      description: "List every item with sku, name, current stock and reorder threshold.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }] }),
  )
  server.registerTool(
    "get_item",
    { description: "Get one item by sku.", inputSchema: { sku: z.string() } },
    async ({ sku }) => {
      const item = items.find((i) => i.sku === sku)
      return item
        ? { content: [{ type: "text" as const, text: JSON.stringify(item) }] }
        : { content: [{ type: "text" as const, text: `No item with sku ${sku}` }], isError: true }
    },
  )
  server.registerTool(
    "restock",
    {
      description: "Set the stock of an item to an absolute quantity. This changes inventory records.",
      inputSchema: { sku: z.string(), quantity: z.number().int().min(0) },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ sku, quantity }) => {
      const item = items.find((i) => i.sku === sku)
      if (!item) return { content: [{ type: "text" as const, text: `No item with sku ${sku}` }], isError: true }
      const before = item.stock
      item.stock = quantity
      return { content: [{ type: "text" as const, text: JSON.stringify({ sku, before, after: quantity }) }] }
    },
  )
  return { server, items }
}

/** node:http ⇄ Web 标准 Request / Response 的搬运（与 @reins/server/node 同一套写法） */
async function toRequest(req: IncomingMessage, base: string): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v)
    else if (Array.isArray(v)) for (const item of v) headers.append(k, item)
  }
  const method = req.method ?? "GET"
  return new Request(`${base}${req.url ?? "/"}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
  })
}

async function pipe(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers))
  const reader = response.body?.getReader()
  if (!reader) return void res.end()
  res.on("close", () => void reader.cancel().catch(() => {}))
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(value)
  }
  res.end()
}

/** 起服务器，返回关闭函数。run.ts 用它在同一进程里起，也可以单独 `node server.ts` */
export async function startInventoryServer(port: number): Promise<() => Promise<void>> {
  const items = INITIAL.map((i) => ({ ...i }))
  const handler = createMcpHandler(() => createInventoryServer(items).server)
  const http = createServer(async (req, res) => {
    try {
      await pipe(await handler.fetch(await toRequest(req, `http://127.0.0.1:${port}`)), res)
    } catch (err) {
      res.writeHead(500).end(String(err))
    }
  })
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve))
  return () =>
    new Promise<void>((resolve) => {
      http.close(() => resolve())
      void handler.close()
    })
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""))) {
  const port = Number(process.env.MCP_PORT ?? 8765)
  await startInventoryServer(port)
  console.log(`inventory MCP server: http://127.0.0.1:${port}/mcp`)
}
