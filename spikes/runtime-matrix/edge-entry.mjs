/**
 * Vercel Edge 入口：edge-runtime 只吃**单文件脚本**（Node vm 上下文，无 ESM 加载器、禁 eval / new Function），
 * 与 Vercel 部署 Edge Function 前必先 bundle 的真实形态一致。host-edge.mjs 用 esbuild 把这个入口连同各包 dist
 * 打成一个 IIFE 再塞进运行时；请求走 Service Worker 式的 fetch 事件，env 由宿主在 vm 上下文里预置为 __REINS_ENV。
 */
import worker from "../edge-runtime-check/worker.mjs"

addEventListener("fetch", (event) => {
  event.respondWith(worker.fetch(event.request, globalThis.__REINS_ENV ?? {}))
})
