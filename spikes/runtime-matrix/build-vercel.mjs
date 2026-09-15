/**
 * 把探针打成 vercel-probe/bundle.js（ESM 单文件），供 vercel-probe/api/probe.js 引用后交给 Vercel 部署。
 * 参数与 host-edge.mjs 同一口径（platform browser、conditions edge-light / worker / browser、node:* external），
 * 差别只是 format=esm——Vercel 的 Edge 函数要 `export default`。
 */
import { build } from "esbuild"

const out = new URL("./vercel-probe/bundle.js", import.meta.url).pathname
const r = await build({
  entryPoints: [new URL("./vercel-entry.mjs", import.meta.url).pathname],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["edge-light", "worker", "browser"],
  external: ["node:*"],
  logLevel: "warning",
})
console.log(`bundle.js 写好，警告 ${r.warnings.length} 条`)
