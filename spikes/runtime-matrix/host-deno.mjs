/**
 * Deno 宿主：把 edge-runtime-check 的标准 fetch 探针挂到 Deno.serve 上。
 * 直接 import 各包 dist——dist 里有 `@earendil-works/pi-ai`、`@modelcontextprotocol/client` 这类裸说明符，
 * 靠 Deno 2 的 byonm（沿最近 package.json 找 node_modules，跟 pnpm 的符号链接）解析。
 * 权限由编排器按需给（--allow-net / --allow-read / --allow-env），不用 -A。
 */
import worker from "../edge-runtime-check/worker.mjs"

const port = Number(Deno.env.get("PORT") ?? 8802)
const env = Deno.env.toObject()
Deno.serve(
  {
    hostname: "127.0.0.1",
    port,
    onListen: () => console.log(`HOST_READY deno ${Deno.version.deno} http://127.0.0.1:${port}`),
  },
  (request) => worker.fetch(request, env),
)
