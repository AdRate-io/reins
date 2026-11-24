/**
 * 把 agent.ts 跑起来的最小服务：`/agent` 挂 handler，`/` 送出 @reinsjs/ui-agui 自带的最小页面。
 * 只用 node:http；用框架的话这文件整个不需要，agent.ts 的 POST 就是路由。
 *
 *   pnpm build && ANTHROPIC_API_KEY=… node examples/minimal/server.ts
 *
 * 缺省只监听本机（127.0.0.1）：这台服务花的是你的 API key，监听全部网卡等于把 key 借给同一网段的所有人。
 * 真要对外，先把 agent.ts 里的 `visitorOf` 换成你的登录态，再设 HOST。
 * 访客 cookie 只在打开页面时发：它只区分"哪个浏览器开的会话"，不是登录。
 */
import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { nodeListener } from "@reinsjs/server/node"
import { agent, VISITOR_COOKIE, visitorIdOf } from "./agent.ts"

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("请设置 ANTHROPIC_API_KEY（走网关再加 REINS_GATEWAY_BASE=https://host/api/v1，给到协议根）")
  process.exit(1)
}

const host = process.env.HOST ?? "127.0.0.1"
const port = Number(process.env.PORT ?? 8787)
const page = await readFile(fileURLToPath(import.meta.resolve("@reinsjs/ui-agui/demo/index.html")))
const handleAgent = nodeListener(agent.handler)

createServer((req, res) => {
  if (req.url?.startsWith("/agent")) return void handleAgent(req, res)
  // 已有合规的访客 cookie 就沿用（刷新页面还能重连自己的会话），没有才发新的
  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" }
  if (visitorIdOf(req.headers.cookie) === undefined) {
    headers["set-cookie"] = `${VISITOR_COOKIE}=${randomBytes(16).toString("hex")}; HttpOnly; SameSite=Strict; Path=/`
  }
  res.writeHead(200, headers)
  res.end(page)
}).listen(port, host, () => {
  console.log(`reins minimal → http://${host.includes(":") ? `[${host}]` : host}:${port}`)
})
