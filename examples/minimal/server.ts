/**
 * 把 agent.ts 跑起来的最小服务：`/agent` 挂 handler，`/` 送出 @reinsjs/ui-agui 自带的最小页面。
 * 只用 node:http；用框架的话这文件整个不需要，agent.ts 的 POST 就是路由。
 *
 *   pnpm build && ANTHROPIC_API_KEY=… node examples/minimal/server.ts
 */
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { nodeListener } from "@reinsjs/server/node"
import { agent } from "./agent.ts"

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("请设置 ANTHROPIC_API_KEY（走网关再加 REINS_GATEWAY_BASE=https://host/api/v1，给到协议根）")
  process.exit(1)
}

const page = await readFile(fileURLToPath(import.meta.resolve("@reinsjs/ui-agui/demo/index.html")))
const handleAgent = nodeListener(agent.handler)

createServer((req, res) => {
  if (req.url?.startsWith("/agent")) return void handleAgent(req, res)
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  res.end(page)
}).listen(Number(process.env.PORT ?? 8787), () => {
  console.log(`reins minimal → http://localhost:${process.env.PORT ?? 8787}`)
})
