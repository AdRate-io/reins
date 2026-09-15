/**
 * Vercel Edge 函数：GET /api/probe?path=/load → 把探针处理器按 path 分派。
 * 用查询参数而不是 rewrites 选路由，免得猜 Vercel 重写后 request.url 里留的是哪个路径。
 * 环境变量（真模型凭证）由部署时 -e 注入，Vercel 线上 Edge 提供 process.env——这正是本次要实证的差异点。
 */
import worker from "../bundle.js"

export const config = { runtime: "edge" }

export default function handler(request) {
  const url = new URL(request.url)
  const path = url.searchParams.get("path") ?? "/"
  const inner = new Request(`https://probe.local${path}`, { method: "GET", headers: request.headers })
  return worker.fetch(inner, process.env)
}
