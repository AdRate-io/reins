/**
 * Bun 宿主：把 edge-runtime-check 的标准 fetch 探针挂到 Bun.serve 上。
 * 直接 import 各包 dist（走 Bun 自己的模块解析与 node_modules 查找），环境变量原样透传给探针。
 */
import worker from "../edge-runtime-check/worker.mjs"

const port = Number(process.env.PORT ?? 8801)
Bun.serve({
  hostname: "127.0.0.1",
  port,
  // Bun.serve 缺省 idleTimeout 10 秒：一次模型调用（含 SDK 对 5xx 的退避重试）很容易超过，超了 Bun 直接掐连接、
  // 客户端只看到 "fetch failed" 而进程毫无报错。给 Bun 宿主的第一条提醒——上限 255 秒
  idleTimeout: 255,
  // Bun 的 fetch 处理器签名与 Workers 一致：(request) => Response
  fetch: (request) => worker.fetch(request, process.env),
})
console.log(`HOST_READY bun ${Bun.version} http://127.0.0.1:${port}`)
