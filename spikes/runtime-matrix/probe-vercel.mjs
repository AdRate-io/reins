/**
 * 打真 Vercel 部署上的探针（deploy-vercel.mjs 部署的项目），复用 fetch-verdict.mjs 的判据。
 * 假端点 / 假 MCP 两格在线上打不到本机，跳过；其余七格：pi 版 load / live / live-openai，fetch 版 load + 三条真模型线。
 *   node probe-vercel.mjs [https://reins-runtime-probe.vercel.app]
 */
import { writeFile } from "node:fs/promises"
import { checkFetch, checkPi } from "../edge-runtime-check/fetch-verdict.mjs"

const base = process.argv[2] ?? "https://reins-runtime-probe.vercel.app"
const CELLS = [
  ["pi", "load", "/load"],
  ["pi", "live-anthropic", "/live"],
  ["pi", "live-openai", "/live-openai"],
  ["fetch", "load", "/fetch-load"],
  ["fetch", "live-chat", "/fetch-live-chat"],
  ["fetch", "live-anthropic", "/fetch-live-anthropic"],
  ["fetch", "live-responses", "/fetch-live-responses"],
]
const results = {}
for (const [layer, kind, path] of CELLS) {
  const r = await fetch(`${base}/api/probe?path=${encodeURIComponent(path)}`, {
    signal: AbortSignal.timeout(120_000),
  })
  const body = await r.json().catch(() => null)
  const x = { status: r.status, body, vercelId: r.headers.get("x-vercel-id") }
  const c = layer === "pi" ? checkPi(kind, x) : checkFetch(kind, x)
  results[`${layer}/${kind}`] = { ...x, 核对: c }
  console.log(
    `${`${layer}/${kind}`.padEnd(22)} HTTP ${r.status}  ${c.通过 ? "通过" : "✗"}  ${c.说明}${x.vercelId ? `  [${x.vercelId}]` : ""}`,
  )
  if (!c.通过) console.log(JSON.stringify(body, null, 1).slice(0, 1500))
}
const 自述 = results["pi/load"].body?.运行时自述
console.log("\n运行时面:", JSON.stringify(自述))
await writeFile(
  new URL("./out-vercel.json", import.meta.url),
  JSON.stringify({ 跑于: new Date().toISOString(), base, results }, null, 2),
)
console.log("落盘 out-vercel.json")
