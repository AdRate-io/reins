/**
 * 把 agent.ts 跑起来的最小服务：`/agent` 挂 handler，`/` 送出 @reinsjs/ui-agui 自带的最小页面。
 * 只用 node:http；用框架的话这文件整个不需要，agent.ts 的 POST 就是路由。
 *
 *   pnpm build && ANTHROPIC_API_KEY=… node examples/minimal/server.ts
 *
 * 缺省只监听本机（127.0.0.1）：这台服务花的是你的 API key，监听全部网卡等于把 key 借给同一网段的所有人。
 * 真要对外，先把 agent.ts 里的 `visitorOf` 换成你的登录态，再设 HOST 与 ALLOWED_HOSTS。
 *
 * 只听本机还不够：恶意站点把自己的域名 DNS 重绑定到 127.0.0.1，就能在"它自己的源"下打开页面、拿到访客 cookie
 * （同站，SameSite 拦不住），再驱动 agent、批准 deploy。所以每个请求都校验 Host 头：
 * - 没设 HOST：只认 `127.0.0.1:<port>`、`localhost:<port>`、`[::1]:<port>`；
 * - 设了 HOST（对外）：必须同时设 ALLOWED_HOSTS（逗号分隔，写浏览器实际发的 Host：
 *   标准端口 80 / 443 不带端口，其余带，如 `agent.example.com,agent.example.com:8443`），
 *   没设就拒绝启动——对外时允许哪些名字只有你知道，不能猜。
 * 其余 Host 一律 421（Misdirected Request）。
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

/** 允许的 Host 头（小写，带端口）；判定见文件头 */
const allowedHosts = (() => {
  if (process.env.HOST === undefined) return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
  const list = (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "")
  if (list.length === 0) {
    console.error("设了 HOST 就必须设 ALLOWED_HOSTS（逗号分隔，写浏览器实际发的 Host），否则挡不住 DNS 重绑定")
    process.exit(1)
  }
  return new Set(list)
})()
const page = await readFile(fileURLToPath(import.meta.resolve("@reinsjs/ui-agui/demo/index.html")))
const handleAgent = nodeListener(agent.handler)

createServer((req, res) => {
  // 先于一切路由：页面与 /agent 都要挡，否则重绑定的源能拿到 cookie
  if (!allowedHosts.has((req.headers.host ?? "").toLowerCase())) {
    res.writeHead(421, { "content-type": "text/plain; charset=utf-8" })
    res.end("misdirected request")
    return
  }
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
