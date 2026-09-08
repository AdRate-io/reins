import {
  type CoreEvent,
  type CoreEventOf,
  createCoreEvent,
  createCoreRegistry,
  defaultProjectionChain,
  defineTool,
  type Event,
  type EventDraft,
  InMemoryEventLog,
  type LoopConfig,
  type RunResult,
  runLoop,
  type TurnContext,
} from "@reins/core"
import { callTool, ScriptedLowering, say } from "@reins/core/testing"
import { describe, expect, it } from "vitest"
import { compact } from "../compact/index.js"
import { findModelPin, lastHostPin, parsePinArgs, pinMetaOf, pins } from "./pins.js"
import { PIN_RULES } from "./rules.js"

const registry = createCoreRegistry()
const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"
type Note = CoreEventOf<"core.system_note">
type Compaction = CoreEventOf<"core.compaction">
type ToolResult = CoreEventOf<"core.tool_result">

/** 全文件共用一个时钟与 id 计数器：同一会话跑多次 run 时 id 不能撞（日志 id 会话内唯一，折叠按 id 判定） */
function deterministic() {
  let t = 1_800_000_000_000
  let n = 0
  return { now: () => ++t, newId: () => `id${++n}` }
}
const clock = deterministic()

const addTool = defineTool<{ a: number; b: number }>({
  name: "add",
  description: "两数相加",
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  execute: ({ a, b }) => a + b,
})

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<{ events: Event[]; result: RunResult }> {
  const events: Event[] = []
  while (true) {
    const step = await gen.next()
    if (step.done) return { events, result: step.value }
    events.push(step.value)
  }
}

async function all(log: InMemoryEventLog): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(SESSION)) out.push(e as CoreEvent)
  return out
}

const types = (events: readonly Event[]) => events.map((e) => e.type.replace("core.", ""))
const notesOf = (events: readonly Event[]) =>
  events.filter((e): e is Note => e.type === "core.system_note" && (e as Note).payload.kind === "pin")
const resultOf = (events: readonly CoreEvent[], toolCallId: string) =>
  events.find(
    (e): e is ToolResult => e.type === "core.tool_result" && e.payload.toolCallId === toolCallId,
  ) as ToolResult
const textOf = (r: ToolResult) => r.payload.content.map((p) => (p.type === "text" ? p.text : "")).join("")

function config(
  lowering: ScriptedLowering,
  log: InMemoryEventLog,
  extra: Partial<LoopConfig> = {},
): LoopConfig {
  return {
    sessionId: SESSION,
    log,
    lowering,
    model: MODEL,
    tools: [addTool],
    systemPrompt: "你是助手",
    input: "把库迁移到 pg，必须保留旧表",
    sockets: [pins({ pins: ["Never touch the production database."] })],
    ...clock,
    ...extra,
  }
}

const doPin = (id: string, args: Record<string, unknown>) => callTool(id, "pin", args)

describe("pins × runLoop：宿主声明的 pin", () => {
  it("首轮把静态 pin 追加在用户消息之后、模型输出之前；三轮系统提示与工具表逐字相同；后续轮与第二次 run 都不再追加", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "add", { a: 1, b: 2 })] },
      { drafts: [callTool("c2", "add", { a: 3, b: 4 })] },
      { drafts: [say("好")] },
    ])
    const { result } = await drain(runLoop(config(lowering, log)))
    expect(result.status).toBe("done")

    const logged = await all(log)
    expect(types(logged).slice(0, 3)).toEqual(["user_message", "system_note", "tool_call"])
    const note = logged[1] as Note
    expect(note.actor).toBe("system")
    expect(note.trust).toBe("system")
    expect(note.payload).toEqual({
      kind: "pin",
      text: "Never touch the production database.",
      meta: { pin: { source: "host", spec: "Never touch the production database." } },
    })
    expect(note.provenance).toEqual({ source: "pins", ref: "Never touch the production database." })
    expect(notesOf(logged)).toHaveLength(1)

    expect(lowering.requests).toHaveLength(3)
    for (const req of lowering.requests) {
      expect(req.systemPrompt).toBe(`你是助手\n\n${PIN_RULES}`)
      expect(req.tools?.map((t) => t.name)).toEqual(["add", "pin"])
    }
    // 首轮请求里模型已看到这条 pin
    expect(types(lowering.requests[0]?.events ?? [])).toEqual(["user_message", "system_note"])

    // 同会话再跑一次：视图里已有同文 pin，不追加
    const lowering2 = new ScriptedLowering([{ drafts: [say("继续")] }])
    await drain(runLoop(config(lowering2, log, { input: "继续" })))
    expect(notesOf(await all(log))).toHaveLength(1)
  })

  it("命名静态 pin 换了文字：新 pin 取代旧 pin（supersedes 指向旧 id）", async () => {
    const log = new InMemoryEventLog()
    const l1 = new ScriptedLowering([{ drafts: [say("ok")] }])
    await drain(
      runLoop(
        config(l1, log, { sockets: [pins({ pins: [{ name: "prod", text: "Do not deploy on Friday." }] })] }),
      ),
    )
    const l2 = new ScriptedLowering([{ drafts: [say("ok")] }])
    await drain(
      runLoop(
        config(l2, log, {
          input: "继续",
          sockets: [pins({ pins: [{ name: "prod", text: "Do not deploy on Friday or Saturday." }] })],
        }),
      ),
    )
    const notes = notesOf(await all(log))
    expect(notes).toHaveLength(2)
    expect(notes[1]?.payload.supersedes).toEqual([notes[0]?.id])
    expect(pinMetaOf(notes[1] as Note)).toEqual({ source: "host", spec: "prod" })
  })

  it("抽取式 pin：随内容变化追加并取代旧值；返回 undefined 时上一条继续生效、不追加", async () => {
    const latestMust = (ctx: TurnContext) => {
      for (let i = ctx.events.length - 1; i >= 0; i--) {
        const e = ctx.events[i] as CoreEvent
        if (e.type !== "core.user_message") continue
        const t = e.payload.content.map((p) => (p.type === "text" ? p.text : "")).join("")
        if (t.includes("必须")) return `User constraint: ${t}`
      }
      return undefined
    }
    const sockets = [pins({ pins: [{ name: "constraint", extract: latestMust }] })]
    const log = new InMemoryEventLog()
    await drain(runLoop(config(new ScriptedLowering([{ drafts: [say("ok")] }]), log, { sockets })))
    await drain(
      runLoop(
        config(new ScriptedLowering([{ drafts: [say("ok")] }]), log, { sockets, input: "先看看表结构" }),
      ),
    )
    await drain(
      runLoop(
        config(new ScriptedLowering([{ drafts: [say("ok")] }]), log, { sockets, input: "必须在周五前完成" }),
      ),
    )
    const notes = notesOf(await all(log))
    expect(notes.map((n) => n.payload.text)).toEqual([
      "User constraint: 把库迁移到 pg，必须保留旧表",
      "User constraint: 必须在周五前完成",
    ])
    expect(notes[1]?.payload.supersedes).toEqual([notes[0]?.id])
  })
})

describe("pins × runLoop：模型的 pin 工具", () => {
  it("pin({ text })：日志顺序 tool_call → system_note(pin, actor=model) → 回执；下一轮视图可见", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [doPin("p1", { text: "Keep the old tables." })] },
      { drafts: [say("好")] },
    ])
    await drain(runLoop(config(lowering, log)))
    const logged = await all(log)
    // user(1) host-pin(2) tool_call(3) note(4) tool_result(5) budget_usage(6)
    expect(types(logged).slice(2, 6)).toEqual(["tool_call", "system_note", "tool_result", "budget_usage"])
    const note = logged[3] as Note
    expect(note.actor).toBe("model")
    expect(note.trust).toBe("model")
    expect(note.parentId).toBe(logged[2]?.id)
    expect(note.provenance).toEqual({ source: "pins", ref: "p1" })
    expect(note.payload).toEqual({
      kind: "pin",
      text: "Keep the old tables.",
      meta: { pin: { source: "model" } },
    })
    expect(textOf(resultOf(logged, "p1"))).toMatch(/^Pinned\./)
    expect(types(lowering.requests[1]?.events ?? [])).toEqual([
      "user_message",
      "system_note",
      "tool_call",
      "system_note",
      "tool_result",
    ])
  })

  it("replaces：替换自己钉的（新 note 取代旧 id）；同文再钉不重复；找不到 / 指向宿主 pin 是错误", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [doPin("p1", { text: "Keep the old tables." })] },
      { drafts: [doPin("p2", { text: "Keep the old tables." })] },
      {
        drafts: [
          doPin("p3", { text: "Keep the old tables until 2026-10.", replaces: "Keep the old tables." }),
        ],
      },
      { drafts: [doPin("p4", { text: "x", replaces: "nothing like this" })] },
      { drafts: [doPin("p5", { text: "x", replaces: "Never touch the production database." })] },
      { drafts: [say("好")] },
    ])
    await drain(runLoop(config(lowering, log)))
    const logged = await all(log)
    const notes = notesOf(logged)
    expect(notes.map((n) => n.payload.text)).toEqual([
      "Never touch the production database.",
      "Keep the old tables.",
      "Keep the old tables until 2026-10.",
    ])
    expect(notes[2]?.payload.supersedes).toEqual([notes[1]?.id])
    expect(textOf(resultOf(logged, "p2"))).toBe("Already pinned; nothing changed.")
    expect(textOf(resultOf(logged, "p3"))).toMatch(/replacing the earlier note/)
    const r4 = resultOf(logged, "p4")
    expect(r4.payload.isError).toBe(true)
    expect(textOf(r4)).toMatch(/No note pinned by you/)
    const r5 = resultOf(logged, "p5")
    expect(r5.payload.isError).toBe(true)
    expect(textOf(r5)).toMatch(/pinned by the host/)
  })

  it("入参校验：空文字、超长文字以 isError 告知模型，不 emit 任何 pin", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [doPin("p1", { text: "   " })] },
      { drafts: [doPin("p2", { text: "x".repeat(501) })] },
      { drafts: [say("好")] },
    ])
    await drain(runLoop(config(lowering, log)))
    const logged = await all(log)
    expect(notesOf(logged).map((n) => pinMetaOf(n)?.source)).toEqual(["host"])
    expect(resultOf(logged, "p1").payload.isError).toBe(true)
    expect(textOf(resultOf(logged, "p2"))).toMatch(/limited to 500/)
  })
})

describe("pins × compact：幸存契约端到端", () => {
  it("整理后 pinsKept 记下宿主 pin 与模型现行 pin，不记被取代的；下一轮视图：摘要 → 幸存者 → 本轮", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [doPin("p1", { text: "Keep the old tables." })] },
      {
        drafts: [
          doPin("p2", { text: "Keep the old tables until 2026-10.", replaces: "Keep the old tables." }),
        ],
      },
      { drafts: [callTool("c1", "add", { a: 1, b: 2 })] },
      { drafts: [callTool("k1", "compact", { summary: "Migrating to pg; computed 1+2=3.", keep: [] })] },
      { drafts: [say("继续")] },
    ])
    const sockets = [pins({ pins: ["Never touch the production database."] }), compact()]
    await drain(runLoop(config(lowering, log, { sockets })))
    const logged = await all(log)
    const notes = notesOf(logged)
    const c = logged.find((e): e is Compaction => e.type === "core.compaction") as Compaction
    // 幸存：最近一条用户消息、宿主 pin、模型的现行 pin；被取代的第一条模型 pin 不在
    expect(c.payload.pinsKept).toEqual([logged[0]?.id, notes[0]?.id, notes[2]?.id])
    expect(c.payload.pinsKept).not.toContain(notes[1]?.id)

    const view = lowering.requests[4]?.events ?? []
    expect(types(view)).toEqual([
      "compaction",
      "user_message",
      "system_note",
      "system_note",
      "tool_call",
      "tool_result",
    ])
    expect(notesOf(view).map((n) => n.payload.text)).toEqual([
      "Never touch the production database.",
      "Keep the old tables until 2026-10.",
    ])
    // 整理后宿主 pin 仍可见且同文，pins 模块不重复注入
    expect(notes).toHaveLength(3)
  })

  it("折叠后重注入的兜底：一条没列出 pin 的 compaction（如宿主自己追加的）把宿主 pin 折掉后，下一轮重新追加并取代旧的", async () => {
    const log = new InMemoryEventLog()
    const sockets = [pins({ pins: ["Never touch the production database."] })]
    await drain(runLoop(config(new ScriptedLowering([{ drafts: [say("ok")] }]), log, { sockets })))
    const before = await all(log) // user(1) pin(2) model_text(3) budget_usage(4)
    const old = notesOf(before)[0] as Note
    await log.append([
      createCoreEvent(registry, {
        type: "core.compaction",
        actor: "host",
        sessionId: SESSION,
        seq: before.length + 1,
        at: 1,
        id: "host-compaction",
        payload: { coversSeq: [1, before.length], summary: "S", decidedBy: "model", pinsKept: [] },
      }),
    ])

    // 缺省 autoKeepPinNotes=true 时 kind=pin 本来就穿越折叠（契约本身）；关掉它才走到模块的兜底路径
    const lowering = new ScriptedLowering([{ drafts: [say("继续")] }])
    await drain(
      runLoop(
        config(lowering, log, {
          sockets,
          input: "继续",
          projection: { strategies: defaultProjectionChain({ fold: { autoKeepPinNotes: false } }) },
        }),
      ),
    )
    const notes = notesOf(await all(log))
    expect(notes).toHaveLength(2)
    expect(notes[1]?.payload.text).toBe(old.payload.text)
    expect(notes[1]?.payload.supersedes).toEqual([old.id])
    // 视图：摘要 → 新用户消息 → 末尾重新注入的 pin（只追加，不改前缀）
    const view = lowering.requests[0]?.events ?? []
    expect(types(view)).toEqual(["compaction", "user_message", "system_note"])
    expect(view.at(-1)?.id).toBe(notes[1]?.id)
  })
})

describe("pins：构造与纯函数", () => {
  it("构造期校验：名字重复、静态文字为空、既无 pin 也无工具、maxTextLength 非法", () => {
    expect(() => pins({ pins: ["a", { name: "a", text: "b" }] })).toThrow(RangeError)
    expect(() => pins({ pins: [{ name: "x", text: " " }] })).toThrow(RangeError)
    expect(() => pins({ pins: [{ name: " ", text: "t" }] })).toThrow(RangeError)
    expect(() => pins({ tool: false })).toThrow(RangeError)
    expect(() => pins({ maxTextLength: 0 })).toThrow(RangeError)
  })

  it("tool:false 只留宿主 pin，不带工具与规则；rules 可替换或关闭", () => {
    const hostOnly = pins({ pins: ["p"], tool: false })
    expect(hostOnly.tools).toBeUndefined()
    expect(hostOnly.systemPrompt).toBeUndefined()
    expect(pins().systemPrompt).toBe(PIN_RULES)
    expect(pins({ rules: "自家规则" }).systemPrompt).toBe("自家规则")
    expect(pins({ rules: false }).systemPrompt).toBeUndefined()
  })

  it("parsePinArgs：规范化与拒绝", () => {
    expect(parsePinArgs({ text: "  a  " })).toEqual({ text: "a" })
    expect(parsePinArgs({ text: "a", replaces: " b " })).toEqual({ text: "a", replaces: "b" })
    expect(() => parsePinArgs("a")).toThrow(RangeError)
    expect(() => parsePinArgs({ text: "" })).toThrow(RangeError)
    expect(() => parsePinArgs({ text: "abc" }, 2)).toThrow(/limited to 2/)
    expect(() => parsePinArgs({ text: "a", replaces: "" })).toThrow(RangeError)
  })

  it("lastHostPin / findModelPin 从后往前找；meta 形状不对的说明不算", () => {
    let seq = 0
    const note = (text: string, meta?: Record<string, unknown>): Event =>
      createCoreEvent(registry, {
        type: "core.system_note",
        actor: "system",
        sessionId: SESSION,
        seq: ++seq,
        at: seq,
        id: `e${seq}`,
        payload: meta ? { kind: "pin", text, meta } : { kind: "pin", text },
      })
    const h1 = note("a", { pin: { source: "host", spec: "s" } })
    const h2 = note("b", { pin: { source: "host", spec: "s" } })
    const m1 = note("c", { pin: { source: "model" } })
    const bad = note("c", { pin: { source: "elsewhere" } })
    const bare = note("c")
    expect(lastHostPin([h1, h2, m1], "s")?.id).toBe(h2.id)
    expect(lastHostPin([h1, h2, m1], "other")).toBeUndefined()
    expect(findModelPin([m1, bad, bare], "c")?.id).toBe(m1.id)
    expect(pinMetaOf(bad as Note)).toBeUndefined()
    expect(pinMetaOf(bare as Note)).toBeUndefined()
  })

  it("beforeModel 永不返回补丁；抽取函数拿到的是 TurnContext", () => {
    const emitted: EventDraft[] = []
    const seen: TurnContext[] = []
    const socket = pins({
      pins: [
        {
          name: "x",
          extract: (ctx) => {
            seen.push(ctx)
            return undefined
          },
        },
      ],
      tool: false,
    })
    const ctx = {
      session: { id: SESSION, turn: 1 },
      events: [],
      timeline: [],
      log: new InMemoryEventLog(),
      tools: [],
      model: MODEL,
      capabilities: {
        api: "scripted",
        midConversationSystem: true,
        thinkingReplay: true,
        parallelTools: true,
        taskBudget: false,
        images: true,
        contextWindow: 1000,
        maxOutputTokens: 100,
      },
      budget: {
        contextLimit: 1000,
        targetTokens: 850,
        used: 0,
        tokensSpent: 0,
        turns: 0,
        toolCalls: 0,
        wallMs: 0,
      },
      emit: (d: EventDraft) => emitted.push(d),
    } as TurnContext
    expect(socket.beforeModel?.(ctx)).toBeUndefined()
    expect(seen).toEqual([ctx])
    expect(emitted).toHaveLength(0)
  })
})
