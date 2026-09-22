import {
  type CoreEvent,
  type CoreEventOf,
  type Event,
  InMemoryBlobStore,
  InMemoryEventLog,
  type LoopConfig,
  type RunResult,
  renderToolReference,
  resolveSocketContributions,
  runLoop,
  type Socket,
  type Tool,
  type ToolReferencePart,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { spill } from "../spill/index.js"
import {
  DEFAULT_LAZY_SUMMARY_CHARS,
  lazyMenuOf,
  lazyTools,
  parseToolFindInput,
  revealedLazyTools,
  summarizeTool,
  toolFindResultBound,
} from "./lazy-tools.js"
import { LAZY_TOOL_RULES, renderLazyToolMenu, renderLoadedTool, TOOL_FIND_TOOL_NAME } from "./rules.js"

const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"
type ToolResultEvent = CoreEventOf<"core.tool_result">

function deterministic() {
  let t = 1_800_000_000_000
  let n = 0
  return { now: () => ++t, newId: () => `id${++n}` }
}

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<{ events: Event[]; result: RunResult }> {
  const events: Event[] = []
  while (true) {
    const step = await gen.next()
    if (step.done) return { events, result: step.value }
    events.push(step.value)
  }
}

async function all(log: InMemoryEventLog, session = SESSION): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(session)) out.push(e as CoreEvent)
  return out
}

const textOf = (r: ToolResultEvent) =>
  r.payload.content.map((p) => (p.type === "text" ? p.text : "")).join("")
const resultOf = (events: readonly CoreEvent[], toolCallId: string) =>
  events.find(
    (e): e is ToolResultEvent => e.type === "core.tool_result" && e.payload.toolCallId === toolCallId,
  ) as ToolResultEvent
const names = (tools: readonly { name: string }[] | undefined) => (tools ?? []).map((t) => t.name)

function tool(name: string, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `Tool ${name}.\nSecond line with details.`,
    inputSchema: { type: "object", properties: { x: { type: "string" } } },
    execute: (input) => `${name}:${JSON.stringify(input)}`,
    ...extra,
  }
}

/** 一件可见工具 + 两件按需的 */
const hostTools = () => [tool("greet"), tool("ads_list", { lazy: true }), tool("ads_disable", { lazy: true })]

const setupOf = (tools: readonly Tool[]) => ({
  log: new InMemoryEventLog(),
  model: MODEL,
  hostTools: tools,
  tools,
})

describe("lazy-tools 纯函数", () => {
  it("summarizeTool：取 description 首个非空行、折叠空白、超长截断加省略号；没正文用工具名", () => {
    expect(summarizeTool(tool("a"))).toBe("Tool a.")
    expect(summarizeTool({ ...tool("a"), description: "\n\n  first   line \n second" })).toBe("first line")
    expect(summarizeTool({ ...tool("a"), description: "   \n" })).toBe("a")
    const long = summarizeTool({ ...tool("a"), description: "x".repeat(500) })
    expect(long.length).toBe(DEFAULT_LAZY_SUMMARY_CHARS)
    expect(long.endsWith("…")).toBe(true)
    expect(summarizeTool({ ...tool("a"), description: "abcdef" }, 4)).toBe("abc…")
  })

  it("lazyMenuOf：只收 lazy: true、按 name 排序、菜单排版一行一项", () => {
    const menu = lazyMenuOf([tool("zeta", { lazy: true }), tool("plain"), tool("alpha", { lazy: true })])
    expect(names(menu.tools)).toEqual(["alpha", "zeta"])
    expect(menu.entries).toEqual([
      { name: "alpha", summary: "Tool alpha." },
      { name: "zeta", summary: "Tool zeta." },
    ])
    expect(renderLazyToolMenu(menu.entries)).toBe(
      "Available on request:\n- alpha: Tool alpha.\n- zeta: Tool zeta.",
    )
    expect(menu.byName.get("alpha")?.name).toBe("alpha")
    // 摘要里的换行折成空格：菜单必须一行一项
    const multi = lazyMenuOf([tool("m", { lazy: true })], () => "a\n  b")
    expect(multi.entries[0]?.summary).toBe("a b")
  })

  it("parseToolFindInput：形状、非空字符串、去重去空白、上限", () => {
    expect(() => parseToolFindInput(null)).toThrow("expects { names: string[] }")
    expect(() => parseToolFindInput({ names: "a" })).toThrow("expects { names: string[] }")
    expect(() => parseToolFindInput({ names: [] })).toThrow("at least one")
    expect(() => parseToolFindInput({ names: ["a", 1] })).toThrow("non-empty strings")
    expect(() => parseToolFindInput({ names: ["  "] })).toThrow("non-empty strings")
    expect(parseToolFindInput({ names: [" a ", "b", "a"] })).toEqual({ names: ["a", "b"] })
    expect(() => parseToolFindInput({ names: ["a", "b", "c"] }, 2)).toThrow("at most 2 per call")
    // 去重后再数：重复的名字不算超限
    expect(parseToolFindInput({ names: ["a", "a", "b"] }, 2)).toEqual({ names: ["a", "b"] })
  })

  it("revealedLazyTools：按 toolCallId 配对成功结果，isError 的不算，不在菜单的名字不算，坏形状跳过", () => {
    const menu = new Set(["ads_list", "ads_disable"])
    const ev = (type: string, payload: unknown, seq: number): Event =>
      ({
        id: `e${seq}`,
        seq,
        at: seq,
        sessionId: SESSION,
        type,
        schemaVersion: 1,
        actor: "model",
        payload,
      }) as Event
    const timeline: Event[] = [
      ev(
        "core.tool_call",
        { toolCallId: "ok", name: TOOL_FIND_TOOL_NAME, args: { names: ["ads_list ", "nope"] } },
        1,
      ),
      ev("core.tool_result", { toolCallId: "ok", name: TOOL_FIND_TOOL_NAME, content: [], isError: false }, 2),
      ev(
        "core.tool_call",
        { toolCallId: "bad", name: TOOL_FIND_TOOL_NAME, args: { names: ["ads_disable"] } },
        3,
      ),
      ev("core.tool_result", { toolCallId: "bad", name: TOOL_FIND_TOOL_NAME, content: [], isError: true }, 4),
      ev("core.tool_call", { toolCallId: "other", name: "greet", args: { names: ["ads_disable"] } }, 5),
      ev("core.tool_result", { toolCallId: "other", name: "greet", content: [], isError: false }, 6),
      ev(
        "core.tool_call",
        { toolCallId: "weird", name: TOOL_FIND_TOOL_NAME, args: { names: [42, null] } },
        7,
      ),
      ev(
        "core.tool_result",
        { toolCallId: "weird", name: TOOL_FIND_TOOL_NAME, content: [], isError: false },
        8,
      ),
      ev(
        "core.tool_call",
        { toolCallId: "pending", name: TOOL_FIND_TOOL_NAME, args: { names: ["ads_disable"] } },
        9,
      ),
    ]
    expect([...revealedLazyTools(timeline, menu)]).toEqual(["ads_list"])
    expect(revealedLazyTools([], menu).size).toBe(0)
  })

  it("toolFindResultBound：最大的 maxPerCall 件条目之和加余量，单件条目不会超", () => {
    const big = tool("big", { lazy: true, description: "b".repeat(4000) })
    const small = tool("small", { lazy: true })
    const menu = lazyMenuOf([big, small])
    const one = toolFindResultBound(menu, 1)
    const two = toolFindResultBound(menu, 2)
    expect(two).toBeGreaterThan(one)
    expect(one).toBeGreaterThanOrEqual(renderLoadedTool(big).length / 4)
    expect(toolFindResultBound(menu, 99)).toBe(two)
  })
})

describe("lazyTools() 静态贡献", () => {
  it("有 lazy 宿主工具：注册 tool_find（risk low、resultTrust system、resultPolicy spill）+ 规则与菜单", async () => {
    const socket = lazyTools({ warn: () => {} })
    const r = await resolveSocketContributions({
      log: new InMemoryEventLog(),
      model: MODEL,
      tools: hostTools(),
      sockets: [socket],
      systemPrompt: "host",
    })
    expect(names(r.tools)).toEqual(["greet", "ads_list", "ads_disable", TOOL_FIND_TOOL_NAME])
    const find = r.tools.find((t) => t.name === TOOL_FIND_TOOL_NAME) as Tool
    expect(find.risk).toBe("low")
    expect(find.resultTrust).toBe("system")
    expect(find.resultPolicy?.overflow).toBe("spill")
    expect(find.resultPolicy?.maxTokens).toBeGreaterThan(256)
    expect(r.systemPrompt).toBe(
      `host\n\n${LAZY_TOOL_RULES}\n\nAvailable on request:\n- ads_disable: Tool ads_disable.\n- ads_list: Tool ads_list.`,
    )
  })

  it("没有一件 lazy 工具：不注册、告警一次（两次 setup 仍只一次）", async () => {
    const warnings: string[] = []
    const socket = lazyTools({ warn: (m) => warnings.push(m) })
    for (let i = 0; i < 2; i++) {
      const r = await resolveSocketContributions({
        log: new InMemoryEventLog(),
        model: MODEL,
        tools: [tool("greet")],
        sockets: [socket],
      })
      expect(r.tools.map((t) => t.name)).toEqual(["greet"])
      expect(r.systemPrompt).toBeUndefined()
    }
    expect(warnings).toEqual([
      expect.stringContaining("No tool bound before lazyTools() is marked lazy: true"),
    ])
  })

  it("宿主或前面的 Socket 已有同名 tool_find：整个不注册、告警一次", async () => {
    const warnings: string[] = []
    const r = await resolveSocketContributions({
      log: new InMemoryEventLog(),
      model: MODEL,
      tools: [tool(TOOL_FIND_TOOL_NAME), tool("ads_list", { lazy: true })],
      sockets: [lazyTools({ warn: (m) => warnings.push(m) })],
    })
    expect(names(r.tools)).toEqual([TOOL_FIND_TOOL_NAME, "ads_list"])
    expect(r.systemPrompt).toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining("already has a tool named")])
    // 前面的 Socket 贡献的同名工具同样以先到者为准，一样不注册
    const w2: string[] = []
    const r2 = await resolveSocketContributions({
      log: new InMemoryEventLog(),
      model: MODEL,
      tools: [tool("ads_list", { lazy: true })],
      sockets: [
        { name: "other", tools: [tool(TOOL_FIND_TOOL_NAME)] },
        lazyTools({ warn: (m) => w2.push(m) }),
      ],
    })
    expect(names(r2.tools)).toEqual(["ads_list", TOOL_FIND_TOOL_NAME])
    expect(r2.systemPrompt).toBeUndefined()
    expect(w2).toEqual([expect.stringContaining("already has a tool named")])
  })

  it("注册在前面的 Socket 贡献的 lazy 工具进菜单（MCP 经 override 标 lazy 的路径）；宿主一件 lazy 都没有也照样注册", async () => {
    const mcpLike: Socket = {
      name: "mcp:tiktok",
      tools: async () => [
        tool("tt_ad_get", { lazy: true }),
        tool("tt_report_get", { lazy: true }),
        tool("tt_meta"),
      ],
    }
    const r = await resolveSocketContributions({
      log: new InMemoryEventLog(),
      model: MODEL,
      tools: [tool("greet")],
      sockets: [mcpLike, lazyTools({ warn: () => {} })],
    })
    expect(names(r.tools)).toEqual(["greet", "tt_ad_get", "tt_report_get", "tt_meta", TOOL_FIND_TOOL_NAME])
    expect(r.systemPrompt).toBe(
      `${LAZY_TOOL_RULES}\n\nAvailable on request:\n- tt_ad_get: Tool tt_ad_get.\n- tt_report_get: Tool tt_report_get.`,
    )
  })

  it("rules 可替换或关掉；summarize / summaryChars 生效；构造期参数校验", async () => {
    const custom = await resolveSocketContributions({
      log: new InMemoryEventLog(),
      model: MODEL,
      tools: hostTools(),
      sockets: [lazyTools({ rules: "RULES", summarize: (t) => `S(${t.name})`, warn: () => {} })],
    })
    expect(custom.systemPrompt).toBe(
      "RULES\n\nAvailable on request:\n- ads_disable: S(ads_disable)\n- ads_list: S(ads_list)",
    )
    const off = await resolveSocketContributions({
      log: new InMemoryEventLog(),
      model: MODEL,
      tools: hostTools(),
      sockets: [lazyTools({ rules: false, warn: () => {} })],
    })
    expect(off.systemPrompt).toBeUndefined()
    expect(names(off.tools)).toContain(TOOL_FIND_TOOL_NAME)
    const short = await resolveSocketContributions({
      log: new InMemoryEventLog(),
      model: MODEL,
      tools: [tool("a", { lazy: true, description: "abcdefgh" })],
      sockets: [lazyTools({ summaryChars: 5, warn: () => {} })],
    })
    expect(short.systemPrompt).toContain("- a: abcd…")
    expect(() => lazyTools({ summaryChars: 0 })).toThrow("summaryChars")
    expect(() => lazyTools({ maxPerCall: 1.5 })).toThrow("maxPerCall")
  })

  it("菜单同一 setup 只算一次：tools 与 systemPrompt 共用", () => {
    let calls = 0
    const socket = lazyTools({
      summarize: (t) => {
        calls++
        return t.name
      },
      warn: () => {},
    })
    const setup = setupOf(hostTools())
    const tools = socket.tools as (s: typeof setup) => unknown
    const prompt = socket.systemPrompt as (s: typeof setup) => unknown
    tools(setup)
    prompt(setup)
    expect(calls).toBe(2) // 两件 lazy 工具各摘要一次，没有第二遍
  })
})

describe("lazyTools() 与 runLoop 集成", () => {
  it("菜单工具首轮不在请求里；tool_find 取回后下一轮可见、可调用；结果 trust=system；tools_bound 仍含全表", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", TOOL_FIND_TOOL_NAME, { names: ["ads_list", "nope"] })] },
      { drafts: [callTool("c2", "ads_list", { x: "1" })] },
      { drafts: [say("done")] },
    ])
    const cfg: LoopConfig = {
      sessionId: SESSION,
      log,
      lowering,
      model: MODEL,
      tools: hostTools(),
      sockets: [lazyTools({ warn: () => {} })],
      systemPrompt: "host",
      input: "开始",
      ...deterministic(),
    }
    const { result } = await drain(runLoop(cfg))
    expect(result.status).toBe("done")
    const events = await all(log)
    const bound = events.find((e) => e.type === "core.tools_bound") as CoreEventOf<"core.tools_bound">
    expect(bound.payload.toolNames).toEqual(["ads_disable", "ads_list", "greet", TOOL_FIND_TOOL_NAME])
    // 每轮请求的工具表：首轮只有 greet + tool_find；取回后 ads_list 加入、ads_disable 仍藏着
    expect(lowering.requests.map((r) => names(r.tools))).toEqual([
      ["greet", TOOL_FIND_TOOL_NAME],
      ["greet", "ads_list", TOOL_FIND_TOOL_NAME],
      ["greet", "ads_list", TOOL_FIND_TOOL_NAME],
    ])
    const found = resultOf(events, "c1")
    expect(found.payload.isError).toBe(false)
    expect(found.trust).toBe("system")
    expect(textOf(found)).toContain("Loaded 1 tool (ads_list); callable from your next turn on.")
    // 定义以引用段表达（L1）：带完整快照，日志自足；降级层按能力位翻成 tool_reference 块或展开成文本
    const ref = found.payload.content.find((p) => p.type === "tool_reference")
    expect(ref).toMatchObject({
      type: "tool_reference",
      name: "ads_list",
      description: "Tool ads_list.\nSecond line with details.",
    })
    expect(renderToolReference(ref as ToolReferencePart)).toContain(
      "### ads_list\nTool ads_list.\nSecond line with details.\nInput schema: {",
    )
    expect(textOf(found)).toContain("Not on the on-request list: nope.")
    const called = resultOf(events, "c2")
    expect(called.payload.isError).toBe(false)
    expect(textOf(called)).toBe('ads_list:{"x":"1"}')
    expect(called.trust).toBe("untrusted")
    // 系统提示每轮逐字相同（菜单是静态贡献）
    expect(new Set(lowering.requests.map((r) => r.systemPrompt)).size).toBe(1)
    expect(lowering.requests[0]?.systemPrompt).toContain("- ads_list: Tool ads_list.")
  })

  it('没取回就直接调菜单工具：被 block 并指向 tool_find，不是"未知工具"；真正未知的工具仍是"未知工具"', async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "ads_disable", { x: "1" }), callTool("c2", "ghost", {})] },
      { drafts: [say("done")] },
    ])
    await drain(
      runLoop({
        sessionId: SESSION,
        log,
        lowering,
        model: MODEL,
        tools: hostTools(),
        sockets: [lazyTools({ warn: () => {} })],
        input: "开始",
        ...deterministic(),
      }),
    )
    const events = await all(log)
    const blocked = resultOf(events, "c1")
    expect(blocked.payload.isError).toBe(true)
    expect(textOf(blocked)).toContain('Tool "ads_disable" is on the on-request list but not loaded yet.')
    expect(textOf(blocked)).toContain(`${TOOL_FIND_TOOL_NAME}({ names: ["ads_disable"] })`)
    expect(textOf(resultOf(events, "c2"))).toContain("Unknown tool: ghost")
    // 没有任何成功的取回：下一轮仍然藏着
    expect(names(lowering.requests[1]?.tools)).toEqual(["greet", TOOL_FIND_TOOL_NAME])
  })

  it("已取回集合从时间线重建：同一会话的下一次 run 首轮就带着上次取回的工具；换一个 Socket 实例也一样", async () => {
    const log = new InMemoryEventLog()
    const first = new ScriptedLowering([
      { drafts: [callTool("c1", TOOL_FIND_TOOL_NAME, { names: ["ads_disable"] })] },
      { drafts: [say("ok")] },
    ])
    const base = { sessionId: SESSION, log, model: MODEL, tools: hostTools() }
    await drain(
      runLoop({
        ...base,
        lowering: first,
        sockets: [lazyTools({ warn: () => {} })],
        input: "第一次",
        ...deterministic(),
      }),
    )
    const second = new ScriptedLowering([
      { drafts: [callTool("c9", "ads_disable", { x: "2" })] },
      { drafts: [say("ok")] },
    ])
    const ids = deterministic()
    await drain(
      runLoop({
        ...base,
        lowering: second,
        sockets: [lazyTools({ warn: () => {} })],
        input: "第二次",
        now: ids.now,
        newId: (at) => `r2-${ids.newId()}-${at}`,
      }),
    )
    expect(names(second.requests[0]?.tools ?? [])).toEqual(["greet", "ads_disable", TOOL_FIND_TOOL_NAME])
    expect(textOf(resultOf(await all(log), "c9"))).toBe('ads_disable:{"x":"2"}')
  })

  it("tool_find 被别的 Socket 拦下（isError）不算取回；一件都没取到的 tool_find 是 isError 且 trust 缺省", async () => {
    const log = new InMemoryEventLog()
    const gate: Socket = {
      name: "gate",
      beforeTool: (_ctx, call) =>
        call.payload.name === TOOL_FIND_TOOL_NAME &&
        (call.payload.args as { names: string[] }).names.includes("ads_disable")
          ? { block: "policy" }
          : undefined,
    }
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", TOOL_FIND_TOOL_NAME, { names: ["ads_disable"] })] },
      { drafts: [callTool("c2", TOOL_FIND_TOOL_NAME, { names: ["nothing", "greet"] })] },
      { drafts: [callTool("c3", TOOL_FIND_TOOL_NAME, { names: [] })] },
      { drafts: [say("done")] },
    ])
    await drain(
      runLoop({
        sessionId: SESSION,
        log,
        lowering,
        model: MODEL,
        tools: hostTools(),
        sockets: [lazyTools({ warn: () => {} }), gate],
        input: "开始",
        ...deterministic(),
      }),
    )
    const events = await all(log)
    expect(resultOf(events, "c1").payload.isError).toBe(true)
    const none = resultOf(events, "c2")
    expect(none.payload.isError).toBe(true)
    expect(none.trust).toBe("untrusted")
    expect(textOf(none)).toContain("Nothing loaded.")
    expect(textOf(none)).toContain("Not on the on-request list: nothing, greet.")
    expect(textOf(resultOf(events, "c3"))).toContain("Invalid arguments")
    for (const r of lowering.requests) expect(names(r.tools)).toEqual(["greet", TOOL_FIND_TOOL_NAME])
  })

  it("注册在 lazyTools() 之后的 Socket 贡献的 lazy 工具：不进菜单也不藏，每轮全量下发，告警一次指出顺序", async () => {
    const other: Socket = { name: "other", tools: [tool("from_socket", { lazy: true })] }
    const warnings: string[] = []
    const lowering = new ScriptedLowering([{ drafts: [say("one")] }, { drafts: [say("done")] }])
    const r = await resolveSocketContributions({
      log: new InMemoryEventLog(),
      model: MODEL,
      tools: hostTools(),
      sockets: [lazyTools({ warn: (m) => warnings.push(m) }), other],
    })
    expect(r.systemPrompt).not.toContain("from_socket")
    const log = new InMemoryEventLog()
    await drain(
      runLoop({
        sessionId: SESSION,
        log,
        lowering,
        model: MODEL,
        tools: hostTools(),
        sockets: [lazyTools({ warn: (m) => warnings.push(m) }), other],
        input: "开始",
        ...deterministic(),
      }),
    )
    await drain(
      runLoop({
        sessionId: SESSION,
        log,
        lowering,
        model: MODEL,
        tools: hostTools(),
        sockets: [lazyTools({ warn: (m) => warnings.push(m) }), other],
        input: "再来",
        ...deterministic(),
      }),
    )
    for (const req of lowering.requests)
      expect(names(req.tools ?? [])).toEqual(["greet", TOOL_FIND_TOOL_NAME, "from_socket"])
    // 两个 lazyTools 实例各告警一次，文案点名工具与顺序
    expect(warnings).toHaveLength(2)
    for (const w of warnings) {
      expect(w).toContain("registered after lazyTools()")
      expect(w).toContain("from_socket")
    }
  })

  it("MCP 形态的 Socket 排在前面：它的 lazy 工具首轮被藏、取回后可见可调用；非 lazy 的照常全程可见", async () => {
    const mcpLike: Socket = {
      name: "mcp:tiktok",
      tools: async () => [
        tool("tt_ad_get", { lazy: true }),
        tool("tt_report_get", { lazy: true }),
        tool("tt_meta"),
      ],
    }
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", TOOL_FIND_TOOL_NAME, { names: ["tt_ad_get"] })] },
      { drafts: [callTool("c2", "tt_ad_get", { x: "1" })] },
      { drafts: [say("done")] },
    ])
    const log = new InMemoryEventLog()
    const { result } = await drain(
      runLoop({
        sessionId: SESSION,
        log,
        lowering,
        model: MODEL,
        tools: [tool("greet")],
        sockets: [mcpLike, lazyTools({ warn: () => {} })],
        input: "开始",
        ...deterministic(),
      }),
    )
    expect(result.status).toBe("done")
    expect(names(lowering.requests[0]?.tools ?? [])).toEqual(["greet", "tt_meta", TOOL_FIND_TOOL_NAME])
    expect(names(lowering.requests[1]?.tools ?? [])).toEqual([
      "greet",
      "tt_ad_get",
      "tt_meta",
      TOOL_FIND_TOOL_NAME,
    ])
    const events = await all(log)
    expect(resultOf(events, "c1").payload.isError).toBe(false)
    expect(textOf(resultOf(events, "c2"))).toBe('tt_ad_get:{"x":"1"}')
  })

  it("与 spill 同装：取回 20 件大 schema 的结果整段进时间线，不被外溢成 blob", async () => {
    const big = Array.from({ length: 20 }, (_, i) =>
      tool(`big_${String(i).padStart(2, "0")}`, {
        lazy: true,
        description: `Tool ${i}. ${"详细说明".repeat(200)}`,
        inputSchema: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 30 }, (_, k) => [
              `p${k}`,
              { type: "string", description: "参数说明".repeat(10) },
            ]),
          ),
        },
      }),
    )
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", TOOL_FIND_TOOL_NAME, { names: big.map((t) => t.name) })] },
      { drafts: [say("done")] },
    ])
    await drain(
      runLoop({
        sessionId: SESSION,
        log,
        blobs: new InMemoryBlobStore(),
        lowering,
        model: MODEL,
        tools: big,
        sockets: [lazyTools({ warn: () => {} }), spill({ maxResultTokens: 2000 })],
        input: "开始",
        ...deterministic(),
      }),
    )
    const r = resultOf(await all(log), "c1")
    expect(r.payload.spilled).toBeUndefined()
    expect(r.payload.content.filter((p) => p.type === "tool_reference")).toHaveLength(20)
    expect(r.payload.content.some((p) => p.type === "tool_reference" && p.name === "big_19")).toBe(true)
    expect(textOf(r)).not.toContain("fetch_blob")
    expect(r.trust).toBe("system")
    expect(names(lowering.requests[1]?.tools)).toEqual([
      ...big.map((t) => t.name),
      TOOL_FIND_TOOL_NAME,
      "fetch_blob",
    ])
  })
})

describe("lazyTools() 原生路径（capabilities.deferredTools，L1）", () => {
  const deferredOf = (tools: readonly { name: string; deferLoading?: boolean }[] | undefined) =>
    Object.fromEntries((tools ?? []).map((t) => [t.name, t.deferLoading === true]))

  it("全表下发、菜单工具标 deferLoading；取回后仍延迟（厂商从历史里的引用块展开）；结果是引用段；未取回直调仍 block", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering(
      [
        { drafts: [callTool("c0", "ads_list", { x: "0" })] },
        { drafts: [callTool("c1", TOOL_FIND_TOOL_NAME, { names: ["ads_list"] })] },
        { drafts: [callTool("c2", "ads_list", { x: "1" })] },
        { drafts: [say("done")] },
      ],
      { capabilities: { deferredTools: true } },
    )
    const cfg: LoopConfig = {
      sessionId: SESSION,
      log,
      lowering,
      model: MODEL,
      tools: hostTools(),
      sockets: [lazyTools({ warn: () => {} })],
      input: "开始",
      ...deterministic(),
    }
    const { result } = await drain(runLoop(cfg))
    expect(result.status).toBe("done")
    // 每个请求的工具表都是全表（表整段不变，缓存前缀不动）
    for (const r of lowering.requests) {
      expect(names(r.tools).sort()).toEqual(["ads_disable", "ads_list", "greet", TOOL_FIND_TOOL_NAME])
    }
    const before = deferredOf(lowering.requests[0]?.tools)
    expect(before).toEqual({ greet: false, [TOOL_FIND_TOOL_NAME]: false, ads_disable: true, ads_list: true })
    // 取回后 ads_list 仍 deferLoading：取回那轮就在视图里，厂商从引用块展开；ads_disable 没取回照样延迟
    const after = deferredOf(lowering.requests[2]?.tools)
    expect(after).toEqual(before)
    const events = await all(log)
    const blocked = resultOf(events, "c0")
    expect(blocked.payload.isError).toBe(true)
    expect(textOf(blocked)).toContain(TOOL_FIND_TOOL_NAME)
    const found = resultOf(events, "c1")
    expect(found.payload.content.map((p) => p.type)).toEqual(["text", "tool_reference"])
    expect(resultOf(events, "c2").payload.isError).toBe(false)
  })

  it("取回那轮被折出本轮视图（如 compact）：该工具不再延迟，定义进 tools 块；其余菜单工具照样延迟", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering(
      [
        { drafts: [callTool("c1", TOOL_FIND_TOOL_NAME, { names: ["ads_list"] })] },
        { drafts: [callTool("c2", "ads_list", { x: "1" })] },
        { drafts: [say("done")] },
      ],
      { capabilities: { deferredTools: true } },
    )
    /** 排在 lazyTools 之前、把 tool_find 那轮从视图里摘掉——模拟 compact 折叠 */
    const fold: Socket = {
      name: "fold",
      beforeModel: (ctx) => ({
        events: ctx.events.filter((e) => {
          if (e.type !== "core.tool_call" && e.type !== "core.tool_result") return true
          return (e.payload as { name: string }).name !== TOOL_FIND_TOOL_NAME
        }),
      }),
    }
    const cfg: LoopConfig = {
      sessionId: SESSION,
      log,
      lowering,
      model: MODEL,
      tools: hostTools(),
      sockets: [fold, lazyTools({ warn: () => {} })],
      input: "开始",
      ...deterministic(),
    }
    const { result } = await drain(runLoop(cfg))
    expect(result.status).toBe("done")
    expect(deferredOf(lowering.requests[0]?.tools)).toMatchObject({ ads_disable: true, ads_list: true })
    // 取回后：视图里没有取回那轮 → ads_list 不延迟（否则模型看不见它），ads_disable 仍延迟；表仍是全表
    expect(deferredOf(lowering.requests[1]?.tools)).toMatchObject({ ads_disable: true, ads_list: false })
    expect(names(lowering.requests[1]?.tools).sort()).toEqual([
      "ads_disable",
      "ads_list",
      "greet",
      TOOL_FIND_TOOL_NAME,
    ])
    expect(resultOf(await all(log), "c2").payload.isError).toBe(false)
  })
})
