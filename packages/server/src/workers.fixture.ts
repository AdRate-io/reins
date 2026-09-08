/**
 * Cloudflare Workers 测试用的 Worker 脚本（由 workers.test.ts 用 esbuild 打包后交给 miniflare/workerd 运行）。
 * 模块级的 log 在同一个 isolate 内跨请求存活，所以 POST 之后 GET 能补发到。
 * 也是"在 Workers 上怎么用"的最小示例：handler 直接接 fetch 的 (request, env, ctx)。
 */
import { defineTool, InMemoryEventLog } from "@reins/core"
import { callTool, ScriptedLowering, say } from "@reins/core/testing"
import { createAgentHandler } from "./index.js"

const add = defineTool<{ a: number; b: number }>({
  name: "add",
  description: "两数相加",
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  execute: ({ a, b }) => a + b,
})

const log = new InMemoryEventLog()
const lowering = new ScriptedLowering([
  { drafts: [callTool("c1", "add", { a: 2, b: 3 })] },
  { drafts: [say("答案是 5")] },
])

const handler = createAgentHandler(
  { log, lowering, model: { provider: "scripted", id: "scripted" }, tools: [add] },
  { heartbeatMs: 0, newSessionId: () => "w1" },
)

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
}

let waitUntilCalls = 0

export default {
  fetch(request: Request, _env: unknown, ctx: ExecutionContextLike): Promise<Response> {
    if (new URL(request.url).pathname === "/stats") {
      return Promise.resolve(Response.json({ waitUntilCalls }))
    }
    return handler(request, {
      waitUntil: (p) => {
        waitUntilCalls++
        ctx.waitUntil(p)
      },
    })
  },
}
