/**
 * `mcpTools({ route })`：同一台服务器、按调用选凭据（AdRate 建议 14，方案 `2026-11-19-MCP按调用选凭据`）。
 *
 * 服务端是真 Streamable HTTP（`createMcpHandler` + 自定义 fetch 垫片），垫片逐请求记下 Authorization 头、
 * JSON-RPC 方法与工具名——"哪次调用带了哪份凭据"只从线上看，不信客户端自述。
 */

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"
import {
  type CoreEvent,
  type CoreEventOf,
  type Event,
  InMemoryEventLog,
  type LoopConfig,
  type RunResult,
  RunStop,
  runLoop,
  type Tool,
  type ToolContext,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { httpTransport } from "./http.js"
import { mcpTools, ROUTE_NOT_SENT_TEXT } from "./mcp-tools.js"
import type { McpRoute, McpRoutedCall, McpToolsSocket, McpTransport } from "./types.js"

const MODEL = { provider: "scripted", id: "scripted" }
const URL_ = "http://mcp.local/mcp"

interface Seen {
  auth: string | null
  http: string
  method?: string
  tool?: string
  account?: string
}

/**
 * 一台"多身份"服务器：认哪些令牌由 `valid` 决定；`slow` 工具挂在 `gate` 上，用来制造在途调用。
 * 每份凭据的令牌在 `tokens` 里，`transportFor(key)` 按键取。
 */
function routedServer() {
  let releaseGate: () => void = () => {}
  let markSlowStarted: () => void = () => {}
  const fx = {
    gate: new Promise<void>((r) => {
      releaseGate = r
    }),
    slowStarted: new Promise<void>((r) => {
      markSlowStarted = r
    }),
    release: () => releaseGate(),
  }
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "routed-fixture", version: "0.0.0" })
    server.registerTool(
      "echo",
      {
        description: "Echo for an account",
        inputSchema: { account: z.string(), text: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ account, text }) => ({ content: [{ type: "text" as const, text: `${account}:${text}` }] }),
    )
    // 没注解：risk medium、不可重放、不要审批（执行前先写 tool_started）
    server.registerTool(
      "plain",
      { description: "Plain write", inputSchema: { account: z.string() } },
      async ({ account }) => ({ content: [{ type: "text" as const, text: `plain ${account}` }] }),
    )
    server.registerTool(
      "write",
      {
        description: "Destructive",
        inputSchema: { account: z.string() },
        annotations: { destructiveHint: true },
      },
      async ({ account }) => ({ content: [{ type: "text" as const, text: `wrote ${account}` }] }),
    )
    server.registerTool(
      "slow",
      { description: "Waits on the gate", inputSchema: { account: z.string() } },
      async ({ account }) => {
        markSlowStarted()
        await fx.gate
        return { content: [{ type: "text" as const, text: `slow ${account}` }] }
      },
    )
    return server
  })

  const valid = new Set(["catalog", "A", "B", "u1", "u2"])
  const seen: Seen[] = []
  const shim: typeof fetch = async (input, init) => {
    const req = new Request(input, init)
    const auth = req.headers.get("authorization")
    const entry: Seen = { auth, http: req.method }
    if (req.method === "POST") {
      try {
        const body = (await req.clone().json()) as {
          method?: string
          params?: { name?: string; arguments?: { account?: string } }
        }
        if (body.method) entry.method = body.method
        if (body.params?.name) entry.tool = body.params.name
        if (body.params?.arguments?.account) entry.account = body.params.arguments.account
      } catch {
        // 非 JSON（不会发生）
      }
    }
    seen.push(entry)
    if (!auth || !valid.has(auth.slice("Bearer ".length)))
      return new Response("unauthorized", { status: 401 })
    return handler.fetch(req)
  }

  const tokens: Record<string, string> = { catalog: "catalog", A: "A", B: "B", u1: "u1", u2: "u2" }
  const refreshes: Record<string, number> = {}
  const transportCalls: string[] = []
  /** 被关掉的路由连接（按键记）：SDK 关连接会调传输的 close，只断言 transportCalls / inits 抓不到漏关 */
  const closes: string[] = []
  /** 测试钩子：路由连接建传输时调用（模拟握手期间被中止） */
  const hooks: { onCreate?: (key: string) => void } = {}
  const counted = (key: string, transport: McpTransport): McpTransport => ({
    ...transport,
    create: () => {
      hooks.onCreate?.(key)
      const inner = transport.create() as { close(): Promise<void> }
      const close = inner.close.bind(inner)
      inner.close = async () => {
        closes.push(key)
        await close()
      }
      return inner
    },
  })
  const transportOf = (key: string) =>
    httpTransport({
      url: URL_,
      fetch: shim,
      auth: {
        token: () => tokens[key],
        onUnauthorized: () => {
          refreshes[key] = (refreshes[key] ?? 0) + 1
          tokens[key] = key // "刷新"：换成服务器认的那份
        },
      },
    })

  /** 缺省路由：入参 account 是 "acc-a" → A、"acc-b" → B */
  const byAccount: McpRoute = {
    keyOf: ({ args }) => ((args as { account?: string }).account === "acc-b" ? "B" : "A"),
    transportFor: (key) => {
      transportCalls.push(key)
      return counted(key, transportOf(key))
    },
  }

  const calls = () => seen.filter((s) => s.method === "tools/call")
  const inits = (token: string) =>
    seen.filter((s) => s.method === "initialize" && s.auth === `Bearer ${token}`).length

  return {
    fx,
    handler,
    seen,
    valid,
    tokens,
    refreshes,
    transportCalls,
    closes,
    hooks,
    transportOf,
    byAccount,
    calls,
    inits,
  }
}

let cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup) await c()
  cleanup = []
})

function socketWith(s: ReturnType<typeof routedServer>, route: McpRoute, extra = {}): McpToolsSocket {
  const socket = mcpTools({ transport: s.transportOf("catalog"), route, ...extra })
  cleanup.push(async () => {
    await socket.close()
    await s.handler.close()
  })
  return socket
}

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<{ events: Event[]; result: RunResult }> {
  const events: Event[] = []
  while (true) {
    const step = await gen.next()
    if (step.done) return { events, result: step.value }
    events.push(step.value)
  }
}

const resultsOf = (events: readonly Event[]) =>
  (events as CoreEvent[]).filter((e): e is CoreEventOf<"core.tool_result"> => e.type === "core.tool_result")
const textOf = (r: CoreEventOf<"core.tool_result">) =>
  r.payload.content.map((c) => (c.type === "text" ? c.text : "")).join("")

function cfg(lowering: ScriptedLowering, log: InMemoryEventLog, extra: Partial<LoopConfig>): LoopConfig {
  let t = 1_800_000_000_000
  let n = 0
  return { sessionId: "s1", log, lowering, model: MODEL, now: () => ++t, newId: () => `id${++n}`, ...extra }
}

/** 不经循环直接拿到 Socket 贡献的工具（直接调 execute 用：并发、在途 evict 这类循环串行执行测不出的场景） */
async function toolsOf(socket: McpToolsSocket): Promise<Map<string, Tool>> {
  const contributed =
    typeof socket.tools === "function"
      ? await socket.tools({ log: new InMemoryEventLog(), model: MODEL, hostTools: [], tools: [] })
      : socket.tools
  return new Map((contributed ?? []).map((t) => [t.name, t]))
}

function ctxOf(extra: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: "s1", toolCallId: "c", log: new InMemoryEventLog(), emit: () => {}, ...extra }
}

describe("mcpTools route：按调用选凭据", () => {
  it("目录连接只做 tools/list；调用按入参走各自凭据；同一键复用连接；keyOf 拿到原名、入参与 ctx", async () => {
    const s = routedServer()
    const keyOfCalls: { call: McpRoutedCall; sessionId: string; principal?: string }[] = []
    const socket = socketWith(
      s,
      {
        ...s.byAccount,
        keyOf: async (call, ctx) => {
          keyOfCalls.push({
            call,
            sessionId: ctx.sessionId,
            ...(ctx.principal ? { principal: ctx.principal.id } : {}),
          })
          return s.byAccount.keyOf(call, ctx)
        },
      },
      { prefix: "tt_" },
    )
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "tt_echo", { account: "acc-a", text: "1" })] },
      { drafts: [callTool("c2", "tt_echo", { account: "acc-b", text: "2" })] },
      { drafts: [callTool("c3", "tt_echo", { account: "acc-a", text: "3" })] },
      { drafts: [say("ok")] },
    ])
    const { events, result } = await drain(
      runLoop(cfg(lowering, log, { sockets: [socket], principal: { id: "boss" } })),
    )
    expect(result.status).toBe("done")
    expect(resultsOf(events).map(textOf)).toEqual(["acc-a:1", "acc-b:2", "acc-a:3"])

    // 线上：tools/list 只带目录令牌；每次调用带对应身份的令牌
    expect(s.seen.filter((x) => x.method === "tools/list").map((x) => x.auth)).toEqual(["Bearer catalog"])
    expect(s.calls().map((x) => [x.account, x.auth])).toEqual([
      ["acc-a", "Bearer A"],
      ["acc-b", "Bearer B"],
      ["acc-a", "Bearer A"],
    ])
    // 目录连接上一次 tools/call 都没有
    expect(s.calls().some((x) => x.auth === "Bearer catalog")).toBe(false)
    // 每个键只建一次连接
    expect(s.transportCalls).toEqual(["A", "B"])
    expect(s.inits("A")).toBe(1)
    expect(s.inits("B")).toBe(1)

    expect(keyOfCalls).toEqual([
      { call: { name: "echo", args: { account: "acc-a", text: "1" } }, sessionId: "s1", principal: "boss" },
      { call: { name: "echo", args: { account: "acc-b", text: "2" } }, sessionId: "s1", principal: "boss" },
      { call: { name: "echo", args: { account: "acc-a", text: "3" } }, sessionId: "s1", principal: "boss" },
    ])
  })

  it("keyOf 抛错：模型看到宿主的文案、isError；返回不合规：isError；都不发 tools/call，也不回退目录连接", async () => {
    const s = routedServer()
    const socket = socketWith(s, {
      ...s.byAccount,
      keyOf: ({ args }) => {
        const account = (args as { account: string }).account
        if (account === "acc-x") throw new Error("This identity has no official tool authorization")
        if (account === "acc-undef") return undefined as unknown as string
        if (account === "acc-empty") return ""
        return 42 as unknown as string
      },
    })
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "echo", { account: "acc-x", text: "" })] },
      { drafts: [callTool("c2", "echo", { account: "acc-undef", text: "" })] },
      { drafts: [callTool("c3", "echo", { account: "acc-empty", text: "" })] },
      { drafts: [callTool("c4", "echo", { account: "acc-num", text: "" })] },
      { drafts: [say("ok")] },
    ])
    const { events } = await drain(runLoop(cfg(lowering, log, { sockets: [socket] })))
    const rs = resultsOf(events)
    expect(rs.every((r) => r.payload.isError)).toBe(true)
    expect(textOf(rs[0] as CoreEventOf<"core.tool_result">)).toBe(
      "Tool execution failed: This identity has no official tool authorization",
    )
    expect(textOf(rs[1] as CoreEventOf<"core.tool_result">)).toMatch(
      /non-empty credential key for tool echo, got undefined/,
    )
    expect(textOf(rs[2] as CoreEventOf<"core.tool_result">)).toMatch(/got an empty string/)
    expect(textOf(rs[3] as CoreEventOf<"core.tool_result">)).toMatch(/got number; the call was not sent/)
    expect(s.calls()).toEqual([])
    expect(s.transportCalls).toEqual([])
  })

  it("发出前被中止（keyOf 返回后 / keyOf 抛错 / transportFor 抛错 / 新键握手期间）：不发 tools/call，模型看到'没发出'而不是'结果未知'（plain 不可重放、已写 tool_started）", async () => {
    for (const mode of ["return", "throw", "transportFor", "handshake"] as const) {
      const s = routedServer()
      const ac = new AbortController()
      const stop = () => ac.abort(new RunStop())
      if (mode === "handshake") s.hooks.onCreate = stop
      const socket = socketWith(s, {
        keyOf: async () => {
          if (mode === "return") stop()
          if (mode === "throw") {
            stop()
            throw new Error("lookup cancelled")
          }
          return "A"
        },
        transportFor: (key) => {
          if (mode === "transportFor") {
            stop()
            throw new Error("vault unavailable")
          }
          return s.byAccount.transportFor(key)
        },
      })
      const log = new InMemoryEventLog()
      const lowering = new ScriptedLowering([{ drafts: [callTool("c1", "plain", { account: "acc-a" })] }])
      const { events, result } = await drain(
        runLoop(cfg(lowering, log, { sockets: [socket], signal: ac.signal })),
      )
      expect(result.status).toBe("paused")
      expect(events.some((e) => e.type === "core.tool_started")).toBe(true)
      const [r] = resultsOf(events)
      expect(r?.payload.isError).toBe(true)
      expect(textOf(r as CoreEventOf<"core.tool_result">), mode).toBe(ROUTE_NOT_SENT_TEXT)
      expect(s.calls()).toEqual([])
      await socket.close()
    }
  })

  it("transportFor 抛错或返回不合规：本次调用失败、不入池，下次路由到该键重新调", async () => {
    const s = routedServer()
    let attempts = 0
    const socket = socketWith(s, {
      keyOf: ({ args }) => (args as { account: string }).account,
      transportFor: (key) => {
        attempts++
        if (key === "bad") throw new Error("no recipe for bad")
        return {} as never
      },
    })
    const echo = (await toolsOf(socket)).get("echo") as Tool
    await expect(echo.execute?.({ account: "bad", text: "" }, ctxOf())).rejects.toThrow("no recipe for bad")
    await expect(echo.execute?.({ account: "bad", text: "" }, ctxOf())).rejects.toThrow("no recipe for bad")
    await expect(echo.execute?.({ account: "weird", text: "" }, ctxOf())).rejects.toThrow(
      "route.transportFor must return an McpTransport, got object",
    )
    await expect(echo.execute?.({ account: "weird", text: "" }, ctxOf())).rejects.toThrow(
      /must return an McpTransport/,
    )
    expect(attempts).toBe(4)
    expect(s.calls()).toEqual([])
  })

  it("同一新键的并发首调用只建一条连接", async () => {
    const s = routedServer()
    const socket = socketWith(s, s.byAccount)
    const echo = (await toolsOf(socket)).get("echo") as Tool
    const out = await Promise.all([
      echo.execute?.({ account: "acc-a", text: "x" }, ctxOf()),
      echo.execute?.({ account: "acc-a", text: "y" }, ctxOf()),
    ])
    expect(out.map((o) => (o as { content: { text: string }[] }).content[0]?.text)).toEqual([
      "acc-a:x",
      "acc-a:y",
    ])
    expect(s.transportCalls).toEqual(["A"])
    expect(s.inits("A")).toBe(1)
  })

  it("按键 401：只调这一把的 onUnauthorized、重试成功；别的键不受影响", async () => {
    const s = routedServer()
    s.tokens.B = "B-expired"
    const socket = socketWith(s, s.byAccount)
    const echo = (await toolsOf(socket)).get("echo") as Tool
    await echo.execute?.({ account: "acc-a", text: "1" }, ctxOf())
    const out = await echo.execute?.({ account: "acc-b", text: "2" }, ctxOf())
    expect((out as { isError: boolean }).isError).toBe(false)
    expect(s.refreshes).toEqual({ B: 1 })
    expect(s.seen.some((x) => x.auth === "Bearer B-expired")).toBe(true)
    expect(s.calls().map((x) => [x.account, x.auth])).toEqual([
      ["acc-a", "Bearer A"],
      ["acc-b", "Bearer B"],
    ])
  })

  it("evict：下一次路由到该键重新取配方、重新握手；其它键的连接照旧复用", async () => {
    const s = routedServer()
    const socket = socketWith(s, s.byAccount)
    const echo = (await toolsOf(socket)).get("echo") as Tool
    await echo.execute?.({ account: "acc-a", text: "1" }, ctxOf())
    await echo.execute?.({ account: "acc-b", text: "1" }, ctxOf())
    await socket.evict("A")
    expect(s.closes).toEqual(["A"]) // 旧连接真的关了
    await socket.evict("A") // 已不在池里：无操作
    await socket.evict("nope")
    expect(s.closes).toEqual(["A"])
    await echo.execute?.({ account: "acc-a", text: "2" }, ctxOf())
    await echo.execute?.({ account: "acc-b", text: "2" }, ctxOf())
    expect(s.transportCalls).toEqual(["A", "B", "A"])
    expect(s.inits("A")).toBe(2)
    expect(s.inits("B")).toBe(1)
  })

  it("evict 时有调用在途：在途调用正常拿到结果，evict 等它结束才关；期间新调用走新连接", async () => {
    const s = routedServer()
    const socket = socketWith(s, s.byAccount)
    const tools = await toolsOf(socket)
    const slow = (tools.get("slow") as Tool).execute?.({ account: "acc-a" }, ctxOf())
    await s.fx.slowStarted

    let evicted = false
    const eviction = socket.evict("A").then(() => {
      evicted = true
    })
    const fresh = await (tools.get("echo") as Tool).execute?.({ account: "acc-a", text: "new" }, ctxOf())
    expect((fresh as { content: { text: string }[] }).content[0]?.text).toBe("acc-a:new")
    expect(s.transportCalls).toEqual(["A", "A"])
    expect(evicted).toBe(false)
    expect(s.closes).toEqual([]) // 在途期间不关

    s.fx.release()
    const out = (await slow) as { content: { text: string }[]; isError: boolean }
    expect(out.isError).toBe(false)
    expect(out.content[0]?.text).toBe("slow acc-a")
    await eviction
    expect(evicted).toBe(true)
    expect(s.closes).toEqual(["A"]) // 只关了被移出的那条，新连接还在池里
  })

  it("evict 等在途期间 close()：被移出的那条也一起关（收摊不等在途），evict 随后结束", async () => {
    const s = routedServer()
    const socket = socketWith(s, s.byAccount)
    const slow = (await toolsOf(socket)).get("slow") as Tool
    const pending = Promise.resolve(slow.execute?.({ account: "acc-a" }, ctxOf())).then(
      () => "resolved",
      () => "rejected",
    )
    await s.fx.slowStarted
    const eviction = socket.evict("A")
    await socket.close()
    expect(s.closes).toEqual(["A"])
    expect(await pending).toBe("rejected") // 收摊掐断了在途调用
    await eviction
    expect(s.closes).toEqual(["A"]) // evict 再关一次是无操作
    s.fx.release()
  })

  it("close：目录连接与池里的连接一起关、池清空；之后再跑按配方重建", async () => {
    const s = routedServer()
    const socket = socketWith(s, s.byAccount)
    const run = (account: string) =>
      drain(
        runLoop(
          cfg(
            new ScriptedLowering([
              { drafts: [callTool("c1", "echo", { account, text: "t" })] },
              { drafts: [say("ok")] },
            ]),
            new InMemoryEventLog(),
            { sockets: [socket] },
          ),
        ),
      )
    await run("acc-a")
    await run("acc-b")
    await socket.close()
    expect([...s.closes].sort()).toEqual(["A", "B"])
    await run("acc-a")
    expect(s.transportCalls).toEqual(["A", "B", "A"])
    expect(s.inits("catalog")).toBe(2)
    expect(s.inits("A")).toBe(2)
  })

  it("审批：暂停时不路由，批准续跑后执行时才调 keyOf 一次", async () => {
    const s = routedServer()
    let routed = 0
    const socket = socketWith(s, {
      ...s.byAccount,
      keyOf: (call, ctx) => {
        routed++
        return s.byAccount.keyOf(call, ctx)
      },
    })
    const log = new InMemoryEventLog()
    const first = await drain(
      runLoop(
        cfg(new ScriptedLowering([{ drafts: [callTool("c1", "write", { account: "acc-b" })] }]), log, {
          sockets: [socket],
          secret: "k",
        }),
      ),
    )
    expect(first.result.status).toBe("paused")
    if (first.result.status !== "paused") throw new Error("unreachable")
    expect(routed).toBe(0)
    const { events, result } = await drain(
      runLoop(
        cfg(new ScriptedLowering([{ drafts: [say("done")] }]), log, {
          sockets: [socket],
          secret: "k",
          resume: first.result.state,
          decisions: [{ toolCallId: "c1", approved: true, by: "boss" }],
        }),
      ),
    )
    expect(result.status).toBe("done")
    expect(routed).toBe(1)
    expect(resultsOf(events).map(textOf)).toEqual(["wrote acc-b"])
    expect(s.calls().map((x) => x.auth)).toEqual(["Bearer B"])
  })

  it("两个 principal 并发共用一个 Socket：各自按自己的 principal 路由", async () => {
    const s = routedServer()
    const socket = socketWith(s, {
      ...s.byAccount,
      keyOf: (_call, ctx) => {
        if (!ctx.principal) throw new Error("no principal")
        return ctx.principal.id
      },
    })
    const runAs = (id: string) =>
      drain(
        runLoop(
          cfg(
            new ScriptedLowering([
              { drafts: [callTool("c1", "echo", { account: `of-${id}`, text: "t" })] },
              { drafts: [say("ok")] },
            ]),
            new InMemoryEventLog(),
            { sessionId: `s-${id}`, sockets: [socket], principal: { id } },
          ),
        ),
      )
    await Promise.all([runAs("u1"), runAs("u2")])
    const pairs = s
      .calls()
      .map((x) => `${x.account}|${x.auth}`)
      .sort()
    expect(pairs).toEqual(["of-u1|Bearer u1", "of-u2|Bearer u2"])
  })

  it("override 包装的 execute 照样经过路由", async () => {
    const s = routedServer()
    const socket = socketWith(s, s.byAccount, {
      override: (tool: Tool) => ({
        ...tool,
        async execute(input: unknown, ctx: ToolContext) {
          const out = (await tool.execute?.(input, ctx)) as { content: { type: "text"; text: string }[] }
          return { ...out, content: [...out.content, { type: "text" as const, text: "+wrapped" }] }
        },
      }),
    })
    const echo = (await toolsOf(socket)).get("echo") as Tool
    const out = (await echo.execute?.({ account: "acc-b", text: "w" }, ctxOf())) as {
      content: { text: string }[]
    }
    expect(out.content.map((c) => c.text)).toEqual(["acc-b:w", "+wrapped"])
    expect(s.calls().map((x) => x.auth)).toEqual(["Bearer B"])
  })

  it("构造期校验；不配 route 时 evict 无操作", async () => {
    const s = routedServer()
    const transport = s.transportOf("catalog")
    expect(() =>
      mcpTools({ transport, route: { keyOf: 1, transportFor: () => transport } as never }),
    ).toThrow("route.keyOf must be a function, got number")
    expect(() => mcpTools({ transport, route: { keyOf: () => "A" } as never })).toThrow(
      "route.transportFor must be a function, got undefined",
    )
    const plain = mcpTools({ transport })
    await expect(plain.evict("A")).resolves.toBeUndefined()
    await plain.close()
    await s.handler.close()
  })
})
