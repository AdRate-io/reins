/**
 * Vercel Edge 宿主（跑在 Node 里）：esbuild 把 edge-entry.mjs 打成单个 IIFE → 交给 edge-runtime 的 EdgeRuntime
 * （Vercel 官方的本地 Edge 运行时，`next dev` 跑 edge 函数用的就是它）→ runServer 起 HTTP。
 *
 * bundle 参数按 Vercel / Next 打 Edge 产物的口径：platform=browser、conditions 带 edge-light / worker / browser，
 * `node:*` 一律 external——Vercel Edge 只放行 async_hooks / events / buffer / assert / util 这一小撮，
 * 其余在运行时不存在，谁在模块初始化时就碰它谁就当场炸，这正是要量的东西。
 *
 * 环境变量：编排器经 REINS_ENV_JSON 一次性传入，宿主放进 vm 上下文的 __REINS_ENV，不走 process.env
 * （edge vm 里的 process.env 是空壳）。
 */

import { EdgeRuntime, runServer } from "edge-runtime"
import { build } from "esbuild"

const port = Number(process.env.PORT ?? 8803)
const env = JSON.parse(process.env.REINS_ENV_JSON ?? "{}")
/**
 * REINS_EDGE_PROCESS_SHIM=1 时往 vm 上下文放一个只有 env 的 process 对象——Vercel 文档对 Edge 运行时承诺的就只有
 * `process.env`（edge-runtime 裸 vm 连这个都没有）。用它分辨"SDK 需要完整 Node process"还是"只要对象存在就行"。
 */
const processShim = process.env.REINS_EDGE_PROCESS_SHIM === "1"

const result = await build({
  entryPoints: [new URL("./edge-entry.mjs", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  conditions: ["edge-light", "worker", "browser"],
  external: ["node:*"],
  logLevel: "silent",
})
const bundleWarnings = result.warnings.map((w) => w.text).filter((t) => /node:|require/.test(t))
const code = result.outputFiles[0].text

const runtime = new EdgeRuntime({
  initialCode: code,
  extend: (context) => {
    context.__REINS_ENV = env
    if (processShim) context.process = { env: { ...env } }
    return context
  },
})
const server = await runServer({ runtime, host: "127.0.0.1", port })
console.log(
  `HOST_READY edge-runtime${processShim ? "+process.env垫片" : ""} ${server.url} bundle=${(code.length / 1024).toFixed(0)}KB warnings=${bundleWarnings.length}`,
)
for (const w of bundleWarnings.slice(0, 10)) console.log(`  bundle-warning: ${w.slice(0, 200)}`)
