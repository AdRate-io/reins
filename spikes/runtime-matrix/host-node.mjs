/**
 * Node 对照臂：同一个 fetch 探针在 Node 22 里跑一遍，作为矩阵的基准线——
 * 某格在 Bun / Deno / Edge 上红、在 Node 上也红，那是上游今天的行为不是运行时差异。
 * Node 没有内建的 fetch 式 serve，这里用 node:http 手工翻译（探针只有 GET，够用）。
 */
import { createServer } from "node:http"
import worker from "../edge-runtime-check/worker.mjs"

const port = Number(process.env.PORT ?? 8804)
createServer(async (req, res) => {
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
  })
  const response = await worker.fetch(request, process.env)
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
}).listen(port, "127.0.0.1", () => console.log(`HOST_READY node ${process.version} http://127.0.0.1:${port}`))
