import {
  type CoreEvent,
  type CoreEventOf,
  defineTool,
  type Event,
  InMemoryEventLog,
  type LoopConfig,
  type RunResult,
  runLoop,
  type Tool,
} from "@reins/core"
import { callTool, ScriptedLowering, say, think } from "@reins/core/testing"
import { describe, expect, it } from "vitest"
import { compact } from "../compact/index.js"
import { pins } from "../pins/index.js"
import { composeHandoffNote, handoff, parseHandoffArgs } from "./handoff.js"
import { HANDOFF_RULES } from "./rules.js"

const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"
type ToolResult = CoreEventOf<"core.tool_result">
type Handoff = CoreEventOf<"core.handoff">
type Note = CoreEventOf<"core.system_note">

function deterministic() {
  let t = 1_800_000_000_000
  let n = 0
  return { now: () => ++t, newId: () => `id${++n}` }
}

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

async function all(log: InMemoryEventLog, sessionId = SESSION): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(sessionId)) out.push(e as CoreEvent)
  return out
}

const types = (events: readonly Event[]) => events.map((e) => e.type.replace("core.", ""))
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
    sockets: [handoff()],
    ...deterministic(),
    ...extra,
  }
}

const doHandoff = (id: string, args: Record<string, unknown>) => callTool(id, "handoff", args)
const ARGS = {
  summary: "Migration to pg: schema copied, data for tables a/b done, table c pending.",
  nextSteps: ["Copy table c", "Verify row counts", "Switch the app connection string"],
}
const NOTE = composeHandoffNote(ARGS)

describe("handoff × runLoop", () => {
  it("工具与规则提示是静态贡献：每轮工具表与系统提示逐字相同", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "add", { a: 1, b: 2 })] },
      { drafts: [say("3")] },
    ])
    await drain(runLoop(config(lowering, log)))
    for (const req of lowering.requests) {
      expect(req.systemPrompt).toBe(`你是助手\n\n${HANDOFF_RULES}`)
      expect(req.tools?.map((t) => t.name)).toEqual(["add", "handoff"])
    }
    expect(lowering.requests[0]?.tools?.find((t) => t.name === "handoff")?.inputSchema).toMatchObject({
      required: ["summary", "nextSteps"],
    })
  })

  it("模型调 handoff：本轮结束交接；旧会话记 handoff（排版后的摘要、缺省触发消息 = 最近用户消息、缺省 reason）；新会话 = 摘要说明 + 触发消息；onHandoff 被调", async () => {
    const log = new InMemoryEventLog()
    const handoffs: [string, string][] = []
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "add", { a: 1, b: 2 })] },
      { drafts: [think("阶段完成，换个会话"), doHandoff("h1", ARGS)] },
    ])
    const { events, result } = await drain(
      runLoop(config(lowering, log, { onHandoff: (a, b) => void handoffs.push([a, b]) })),
    )
    expect(result.status).toBe("handoff")
    if (result.status !== "handoff") return
    expect(handoffs).toEqual([[SESSION, result.toSessionId]])

    const old = await all(log)
    expect(types(old)).toEqual([
      "user_message",
      "tool_call",
      "tool_result",
      "budget_usage",
      "model_thinking",
      "tool_call",
      "tool_result",
      "budget_usage",
      "handoff",
    ])
    const receipt = resultOf(old, "h1")
    expect(receipt.payload.isError).toBe(false)
    expect(textOf(receipt)).toContain("Handoff scheduled")
    expect(textOf(receipt)).toContain("3 next steps, 0 pinned notes, the message to act on")

    const ho = old.at(-1) as Handoff
    expect(ho.actor).toBe("model")
    expect(ho.payload).toEqual({
      toSessionId: result.toSessionId,
      summary: NOTE,
      triggerMessage: "把库迁移到 pg，必须保留旧表",
      reason: "model_decision",
    })
    expect(NOTE).toBe(
      [
        "Handoff from a previous session. What follows was written by the model before handing off; nothing else from that session is available here.",
        "",
        "## Summary",
        ARGS.summary,
        "",
        "## Next steps",
        "1. Copy table c",
        "2. Verify row counts",
        "3. Switch the app connection string",
      ].join("\n"),
    )

    const fresh = await all(log, result.toSessionId)
    expect(fresh.map((e) => [e.seq, e.type])).toEqual([
      [1, "core.system_note"],
      [2, "core.user_message"],
    ])
    expect((fresh[0] as Note).payload).toEqual({ kind: "host", text: NOTE })
    expect((fresh[1] as CoreEventOf<"core.user_message">).payload.content).toEqual([
      { type: "text", text: "把库迁移到 pg，必须保留旧表" },
    ])
    // 新会话的两条也 yield 给了宿主
    expect(events.filter((e) => e.sessionId === result.toSessionId)).toHaveLength(2)
  })

  it("显式 triggerMessage 与 reason 生效；nextSteps 可为空则不排'下一步'段", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      {
        drafts: [
          doHandoff("h1", {
            summary: "All done except the final report.",
            nextSteps: [],
            triggerMessage: "Write the final report",
            reason: "phase_boundary",
          }),
        ],
      },
    ])
    const { result } = await drain(runLoop(config(lowering, log)))
    if (result.status !== "handoff") throw new Error(result.status)
    const ho = (await all(log)).at(-1) as Handoff
    expect(ho.payload.reason).toBe("phase_boundary")
    expect(ho.payload.triggerMessage).toBe("Write the final report")
    expect(ho.payload.summary).not.toContain("## Next steps")
    expect(ho.payload.summary).toContain("## Summary\nAll done except the final report.")
  })

  it("pin 跟着走：可见且未被取代的宿主 pin 与模型 pin 复制到新会话开头（保留 meta 与 actor），被取代的不带；新会话再跑 pins() 不重复注入", async () => {
    const log = new InMemoryEventLog()
    const sockets = [handoff(), pins({ pins: ["Never touch the production database."] })]
    const lowering = new ScriptedLowering([
      { drafts: [callTool("p1", "pin", { text: "Old table name: users_v1" })] },
      {
        drafts: [
          callTool("p2", "pin", {
            text: "Old table name: users_legacy",
            replaces: "Old table name: users_v1",
          }),
        ],
      },
      { drafts: [doHandoff("h1", ARGS)] },
    ])
    const { result } = await drain(runLoop(config(lowering, log, { sockets })))
    if (result.status !== "handoff") throw new Error(result.status)
    const receipt = resultOf(await all(log), "h1")
    expect(textOf(receipt)).toContain("2 pinned notes")

    const fresh = await all(log, result.toSessionId)
    expect(fresh.map((e) => [e.seq, e.type, e.actor])).toEqual([
      [1, "core.system_note", "host"],
      [2, "core.system_note", "system"],
      [3, "core.system_note", "model"],
      [4, "core.user_message", "user"],
    ])
    const hostPin = fresh[1] as Note
    expect(hostPin.payload).toEqual({
      kind: "pin",
      text: "Never touch the production database.",
      meta: { pin: { source: "host", spec: "Never touch the production database." } },
    })
    expect(hostPin.trust).toBe("system")
    expect(hostPin.provenance).toEqual({ source: "handoff", ref: "id2" })
    const modelPin = fresh[2] as Note
    expect(modelPin.payload).toEqual({
      kind: "pin",
      text: "Old table name: users_legacy",
      meta: { pin: { source: "model" } },
    })
    expect(modelPin.payload.supersedes).toBeUndefined()
    expect(modelPin.trust).toBe("model")
    expect(
      fresh.some((e) => e.type === "core.system_note" && (e as Note).payload.text.includes("users_v1")),
    ).toBe(false)

    // 新会话再跑一次（宿主起 runLoop，不带 input）：pins() 看到同名同文的宿主 pin，不再注入
    const lowering2 = new ScriptedLowering([{ drafts: [say("Continuing from the handoff.")] }])
    const cfg2 = config(lowering2, log, { sessionId: result.toSessionId, sockets })
    delete cfg2.input
    const second = await drain(runLoop(cfg2))
    expect(second.result.status).toBe("done")
    const seen = lowering2.requests[0]?.events ?? []
    expect(types(seen)).toEqual(["system_note", "system_note", "system_note", "user_message"])
    expect(types(await all(log, result.toSessionId))).toEqual([
      "system_note",
      "system_note",
      "system_note",
      "user_message",
      "model_text",
      "budget_usage",
    ])
  })

  it("carryPins: false 时不带 pin", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("p1", "pin", { text: "keep me" })] },
      { drafts: [doHandoff("h1", ARGS)] },
    ])
    const { result } = await drain(
      runLoop(config(lowering, log, { sockets: [handoff({ carryPins: false }), pins()] })),
    )
    if (result.status !== "handoff") throw new Error(result.status)
    expect(types(await all(log, result.toSessionId))).toEqual(["system_note", "user_message"])
  })

  it("同轮其他工具照常执行，交接在轮末；同轮第二次 handoff 报错且只交接一次", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      {
        drafts: [
          doHandoff("h1", ARGS),
          callTool("c1", "add", { a: 5, b: 6 }),
          doHandoff("h2", { ...ARGS, summary: "second" }),
        ],
      },
    ])
    const { result } = await drain(runLoop(config(lowering, log)))
    if (result.status !== "handoff") throw new Error(result.status)
    const old = await all(log)
    expect(textOf(resultOf(old, "c1"))).toBe("11")
    expect(resultOf(old, "h2").payload.isError).toBe(true)
    expect(textOf(resultOf(old, "h2"))).toContain("already scheduled")
    expect(old.filter((e) => e.type === "core.handoff")).toHaveLength(1)
    expect((old.at(-1) as Handoff).payload.summary).toBe(NOTE)
  })

  it("入参不合法 → isError、不交接、run 正常结束", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      {
        drafts: [
          doHandoff("h1", { summary: "", nextSteps: [] }),
          doHandoff("h2", { summary: "x", nextSteps: "no" }),
        ],
      },
      { drafts: [say("好吧，继续")] },
    ])
    const { result } = await drain(runLoop(config(lowering, log)))
    expect(result.status).toBe("done")
    const old = await all(log)
    expect(textOf(resultOf(old, "h1"))).toContain("`summary`")
    expect(textOf(resultOf(old, "h2"))).toContain("`nextSteps`")
    expect(old.some((e) => e.type === "core.handoff")).toBe(false)
  })

  it("与 compact 共存：handoff 排在前面时模型同轮调 compact 再 handoff，整理入日志且交接发生", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "add", { a: 1, b: 2 })] },
      {
        drafts: [callTool("k1", "compact", { summary: "1+2=3 done", keep: ["3"] }), doHandoff("h1", ARGS)],
      },
    ])
    const { result } = await drain(runLoop(config(lowering, log, { sockets: [handoff(), compact()] })))
    expect(result.status).toBe("handoff")
    const old = await all(log)
    expect(old.some((e) => e.type === "core.compaction")).toBe(true)
    expect(old.at(-1)?.type).toBe("core.handoff")
  })

  it("构造选项：rules 可替换或关闭", () => {
    expect(handoff().systemPrompt).toBe(HANDOFF_RULES)
    expect(handoff({ rules: false }).systemPrompt).toBeUndefined()
    expect(handoff({ rules: "自定义" }).systemPrompt).toBe("自定义")
    expect((handoff().tools as readonly Tool[]).map((t) => t.name)).toEqual(["handoff"])
  })
})

describe("handoff 纯函数", () => {
  it("parseHandoffArgs：规范化与拒绝", () => {
    expect(parseHandoffArgs({ summary: " s ", nextSteps: [" a ", "", "b"], reason: " r " })).toEqual({
      summary: "s",
      nextSteps: ["a", "b"],
      reason: "r",
    })
    expect(() => parseHandoffArgs(null)).toThrow("expects an object")
    expect(() => parseHandoffArgs({ nextSteps: [] })).toThrow("`summary`")
    expect(() => parseHandoffArgs({ summary: "s" })).toThrow("`nextSteps`")
    expect(() => parseHandoffArgs({ summary: "s", nextSteps: [1] })).toThrow("`nextSteps`")
    expect(() => parseHandoffArgs({ summary: "s", nextSteps: [], triggerMessage: " " })).toThrow(
      "`triggerMessage`",
    )
  })
})
