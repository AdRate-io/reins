/**
 * Streamable HTTP：客户端传输 → 自定义 fetch → 服务端 `createMcpHandler(...).fetch(Request)`。
 * 不过 socket，但 HTTP 语义（POST JSON-RPC、SSE / JSON 响应、按请求的 2026-07 信封、鉴权头）全部真实走一遍。
 * 服务端用 createMcpHandler 而不是单个 WebStandardStreamableHTTPServerTransport：后者只服务一个会话，
 * 第二个客户端 initialize 就 400 "Server already initialized"（examples/mcp 第一次真跑踩到的）。
 */

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"
import { type Event, InMemoryEventLog, type RunResult, runLoop } from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { httpTransport } from "./http.js"
import { mcpTools } from "./mcp-tools.js"

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<Event[]> {
  const events: Event[] = []
  while (true) {
    const step = await gen.next()
    if (step.done) return events
    events.push(step.value)
  }
}

describe("httpTransport：Streamable HTTP 走完整协议路径", () => {
  it("list + call 成功；鉴权头随每个请求发出；标签不含查询串；第二个客户端先后初始化也行", async () => {
    let instances = 0
    const handler = createMcpHandler(() => {
      instances++
      const server = new McpServer({ name: "http-fixture", version: "0.0.0" })
      server.registerTool(
        "echo",
        { description: "echo", inputSchema: { text: z.string() } },
        async ({ text }) => ({
          content: [{ type: "text" as const, text: `echo:${text}` }],
        }),
      )
      return server
    })

    const seenAuth = new Set<string | null>()
    const seenMethods: string[] = []
    const shim: typeof fetch = async (input, init) => {
      const req = new Request(input, init)
      seenAuth.add(req.headers.get("authorization"))
      seenMethods.push(req.method)
      return handler.fetch(req)
    }
    const transport = httpTransport({
      url: "http://mcp.local/mcp?token=secret",
      headers: { Authorization: "Bearer t0k" },
      fetch: shim,
    })
    expect(transport.label).toBe("http://mcp.local/mcp")

    const socket = mcpTools({ transport })
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "echo", { text: "hi" })] },
      { drafts: [say("ok")] },
    ])
    const events = await drain(
      runLoop({ sessionId: "s", log, lowering, model: { provider: "x", id: "y" }, sockets: [socket] }),
    )
    expect((lowering.requests[0]?.tools ?? []).map((t) => t.name)).toEqual(["echo"])
    const result = events.find((e) => e.type === "core.tool_result") as
      | { payload: { content: { type: string; text?: string }[] } }
      | undefined
    expect(result?.payload.content).toEqual([{ type: "text", text: "echo:hi" }])
    expect([...seenAuth]).toEqual(["Bearer t0k"])
    expect(seenMethods).toContain("POST")
    await socket.close()

    // 第二个客户端（宿主按请求重建、或另一个进程）再来一遍：服务端按请求建实例，不会 "Server already initialized"
    const second = mcpTools({ transport })
    const again = new ScriptedLowering([{ drafts: [say("ok")] }])
    await drain(
      runLoop({
        sessionId: "s2",
        log,
        lowering: again,
        model: { provider: "x", id: "y" },
        sockets: [second],
      }),
    )
    expect((again.requests[0]?.tools ?? []).map((t) => t.name)).toEqual(["echo"])
    expect(instances).toBeGreaterThan(1)
    await second.close()
    await handler.close()
  })

  it("auth：令牌每个请求现取（跨 run 也重新取），401 触发 onUnauthorized 后自动重试一次", async () => {
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "auth-fixture", version: "0.0.0" })
      server.registerTool(
        "echo",
        { description: "echo", inputSchema: { text: z.string() } },
        async ({ text }) => ({
          content: [{ type: "text" as const, text: `echo:${text}` }],
        }),
      )
      return server
    })

    // 服务端认的令牌与客户端手上的令牌是两份：让它们错开，就是 access token 过期的真实形态
    let serverAccepts = "t1"
    let clientToken = "t1"
    let issued = 0
    let refreshes = 0
    const seenAuth: (string | null)[] = []
    const shim: typeof fetch = async (input, init) => {
      const req = new Request(input, init)
      const got = req.headers.get("authorization")
      seenAuth.push(got)
      if (got !== `Bearer ${serverAccepts}`) return new Response("unauthorized", { status: 401 })
      return handler.fetch(req)
    }

    const transport = httpTransport({
      url: "http://mcp.local/mcp",
      fetch: shim,
      auth: {
        // 同步返回也合法（我们的签名收 MaybePromise）
        token: () => {
          issued++
          return clientToken
        },
        onUnauthorized: async () => {
          refreshes++
          clientToken = serverAccepts // "刷新"：宿主换到新令牌，下一次 token() 返回它
        },
      },
    })

    const socket = mcpTools({ transport })
    const log = new InMemoryEventLog()
    const first = new ScriptedLowering([
      { drafts: [callTool("c1", "echo", { text: "hi" })] },
      { drafts: [say("ok")] },
    ])
    await drain(
      runLoop({ sessionId: "s", log, lowering: first, model: { provider: "x", id: "y" }, sockets: [socket] }),
    )
    expect(issued).toBeGreaterThan(1) // 每个请求都现取，不是建连时取一次
    expect(refreshes).toBe(0)
    expect(new Set(seenAuth)).toEqual(new Set(["Bearer t1"]))

    // 令牌在两次 run 之间过期：连接还在复用，但下一个请求会 401 → onUnauthorized 刷新 → 自动重试一次并成功
    serverAccepts = "t2"
    const before = seenAuth.length
    const second = new ScriptedLowering([
      { drafts: [callTool("c2", "echo", { text: "again" })] },
      { drafts: [say("ok")] },
    ])
    const events = await drain(
      runLoop({
        sessionId: "s2",
        log,
        lowering: second,
        model: { provider: "x", id: "y" },
        sockets: [socket],
      }),
    )
    expect(refreshes).toBeGreaterThan(0)
    const retried = seenAuth.slice(before)
    expect(retried).toContain("Bearer t2") // 刷新后的令牌真的发出去了
    const result = events.find((e) => e.type === "core.tool_result") as
      | { payload: { content: { type: string; text?: string }[]; isError?: boolean } }
      | undefined
    expect(result?.payload.isError ?? false).toBe(false) // 重试成功，模型看到的是正常结果
    expect(result?.payload.content).toEqual([{ type: "text", text: "echo:again" }])

    await socket.close()
    await handler.close()
  })

  it("auth 与 headers.Authorization 同时给：构造期就拒绝（不静默让一个盖掉另一个）", () => {
    const auth = { token: () => "t" }
    expect(() =>
      httpTransport({ url: "http://mcp.local/mcp", auth, headers: { Authorization: "Bearer x" } }),
    ).toThrow(/cannot be used together/)
    // 头名大小写不敏感
    expect(() =>
      httpTransport({ url: "http://mcp.local/mcp", auth, headers: { authorization: "Bearer x" } }),
    ).toThrow(/cannot be used together/)
    // 其它头不冲突
    expect(() =>
      httpTransport({ url: "http://mcp.local/mcp", auth, headers: { "X-Tenant": "a" } }),
    ).not.toThrow()
  })
})
