/**
 * `@reinsjs/server/node` 的 nodeListener：handler 抛错不能让进程崩、请求必须拿到响应。
 * 用真 node:http 服务器（端口 0）跑，覆盖的是宿主照 README `createServer(nodeListener(handler))` 的真实接法。
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nodeListener } from "./node.js"
import type { AgentHandler } from "./types.js"

let server: Server | undefined

beforeEach(() => {
  // 兜底会把完整错误打到 console.error；这里静音并在用例里断言确实报了
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  const s = server
  server = undefined
  if (!s) return
  s.closeAllConnections()
  await new Promise<void>((r) => s.close(() => r()))
})

/** 起一个包着 handler 的真服务器，返回基址 */
async function serve(handler: AgentHandler): Promise<string> {
  const s = createServer(nodeListener(handler))
  server = s
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}

describe("nodeListener：handler 抛错", () => {
  it("抛普通错误（如租约存储不可用）回 500 JSON，不留未处理的 rejection", async () => {
    const base = await serve(async () => {
      throw new Error("db down")
    })
    const res = await fetch(`${base}/`, {
      method: "POST",
      body: JSON.stringify({ input: "hi" }),
      signal: AbortSignal.timeout(2000),
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe("internal_error")
    // 错误细节不外泄给客户端
    expect(body.message).not.toContain("db down")
    expect(console.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: "db down" }),
    )
  })

  it("抛出的 Response（principal / authorizeSession 的拒绝）原样写回", async () => {
    const base = await serve(async () => {
      throw new Response("nope", { status: 401, headers: { "x-why": "token" } })
    })
    const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) })
    expect(res.status).toBe(401)
    expect(res.headers.get("x-why")).toBe("token")
    expect(await res.text()).toBe("nope")
  })

  it("服务器在抛错之后照常服务下一个请求", async () => {
    let calls = 0
    const base = await serve(async () => {
      calls++
      if (calls === 1) throw new Error("transient")
      return new Response("ok")
    })
    expect((await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) })).status).toBe(500)
    const second = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) })
    expect(second.status).toBe(200)
    expect(await second.text()).toBe("ok")
  })

  it("响应体读到一半出错：连接被销毁，不挂住、不崩进程", async () => {
    const base = await serve(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: 1\n\n"))
          setTimeout(() => c.error(new Error("store gone")), 20)
        },
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    })
    const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) })
    expect(res.status).toBe(200)
    await expect(res.text()).rejects.toThrow()
  })
})

describe("nodeListener：客户端断开", () => {
  it('handler 还没返回时客户端就断开：拿到响应流后立即取消（onDisconnect: "abort" 靠它中止 run）', async () => {
    let cancelled = false
    let ticks = 0
    const handler: AgentHandler = async () => {
      // 模拟鉴权 / 读日志 / 抢租约较慢，客户端在这期间关页
      await new Promise((r) => setTimeout(r, 300))
      let timer: ReturnType<typeof setInterval> | undefined
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          timer = setInterval(() => {
            ticks++
            c.enqueue(new TextEncoder().encode(": ping\n\n"))
          }, 20)
        },
        cancel() {
          cancelled = true
          clearInterval(timer)
        },
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    const base = await serve(handler)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    await fetch(`${base}/`, { signal: ac.signal }).catch(() => {})
    await new Promise((r) => setTimeout(r, 500))
    expect(cancelled).toBe(true)
    // 断开之后不该再往死连接上写心跳
    expect(ticks).toBeLessThanOrEqual(1)
  })

  it("流进行中客户端断开：响应流被取消", async () => {
    let cancelled = false
    const handler: AgentHandler = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: 1\n\n"))
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    const base = await serve(handler)
    const ac = new AbortController()
    const res = await fetch(`${base}/`, { signal: ac.signal })
    await res.body?.getReader().read()
    ac.abort()
    await new Promise((r) => setTimeout(r, 200))
    expect(cancelled).toBe(true)
  })
})
