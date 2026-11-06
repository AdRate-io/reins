/**
 * run 进行中拉取新输入（2026-11-06，OnSet 建议 13，docs/implementation-plans/2026-11-06-运行中拉取新输入.md）。
 *
 * 拉取点只有一个：每次调模型前、投影之前；补跑 pending 的那轮与已触顶 maxTurns 时不拉。
 * 白名单比起步 input 窄（不收 tool_result）；返回值不合规以 error 结束、回调抛错 fail-open、拉完已中止就不写。
 */
import { describe, expect, it } from "vitest"
import type { Event } from "../events/base.js"
import type { CoreEvent } from "../events/core.js"
import type { EventDraft } from "../events/create.js"
import { InMemoryEventLog } from "../store/in-memory.js"
import { callTool, ScriptedLowering, type ScriptedTurn, say } from "../testing/scripted-lowering.js"
import { runLoop } from "./run-loop.js"
import { RunStop } from "./stop.js"
import { defineTool } from "./tools.js"
import type { LoopConfig, PullInputContext, RunResult, Socket, Tool } from "./types.js"

const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"

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

async function all(log: InMemoryEventLog): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(SESSION)) out.push(e as CoreEvent)
  return out
}

const types = (events: readonly Event[]) => events.map((e) => e.type.replace("core.", ""))

const readTool: Tool = defineTool<Record<string, never>>({
  name: "look",
  description: "",
  inputSchema: { type: "object" },
  risk: "low",
  execute: () => "looked",
})

const note = (text: string): EventDraft => ({
  type: "core.system_note",
  actor: "host",
  payload: { kind: "host", text },
})
const user = (text: string): EventDraft => ({
  type: "core.user_message",
  actor: "user",
  payload: { content: [{ type: "text", text }] },
})

/** 第 1 轮调工具、第 2 轮收尾 */
const twoTurns: ScriptedTurn[] = [{ drafts: [callTool("c1", "look", {})] }, { drafts: [say("done")] }]

function setup(script: ScriptedTurn[] | ConstructorParameters<typeof ScriptedLowering>[0] = twoTurns) {
  const log = new InMemoryEventLog()
  const lowering = new ScriptedLowering(script)
  const base: LoopConfig = {
    sessionId: SESSION,
    log,
    lowering,
    model: MODEL,
    tools: [readTool],
    ...deterministic(),
  }
  return { log, lowering, base }
}

/** 记下每次拉取的 turn；按轮次返回脚本里的草稿 */
function puller(byTurn: Record<number, readonly EventDraft[]> = {}) {
  const calls: PullInputContext[] = []
  const pullInput = (ctx: PullInputContext) => {
    calls.push(ctx)
    return byTurn[ctx.turn] ?? []
  }
  return { calls, pullInput }
}

describe("pullInput 拉取点", () => {
  it("第 2 轮调模型前拉到 [note, user]：落在上一轮 tool_result 之后、本轮 beforeModel 说明之前，模型看得见", async () => {
    const { log, lowering, base } = setup()
    const { calls, pullInput } = puller({ 2: [note("background"), user("change of plan")] })
    // 模拟 pins / perception：每轮 beforeModel 写一条说明
    const perception: Socket = {
      name: "perception-like",
      beforeModel: (ctx) => {
        ctx.emit({ type: "core.system_note", actor: "system", payload: { kind: "perception", text: "p" } })
        return undefined
      },
    }
    const { result } = await drain(runLoop({ ...base, input: "go", pullInput, sockets: [perception] }))
    expect(result.status).toBe("done")
    expect(calls).toEqual([
      { sessionId: SESSION, turn: 1 },
      { sessionId: SESSION, turn: 2 },
    ])

    const log2 = await all(log)
    const resultIdx = log2.findIndex((e) => e.type === "core.tool_result")
    const after = log2.slice(resultIdx + 1)
    // budget_usage 在 tool_result 之后（上一轮的用量），随后是拉到的两条，再是本轮的感知说明
    const noteIdx = after.findIndex((e) => e.type === "core.system_note" && e.payload.kind === "host")
    const userIdx = after.findIndex((e) => e.type === "core.user_message")
    const percIdx = after.findIndex((e) => e.type === "core.system_note" && e.payload.kind === "perception")
    expect(noteIdx).toBeGreaterThanOrEqual(0)
    expect(userIdx).toBe(noteIdx + 1)
    expect(percIdx).toBeGreaterThan(userIdx)
    // 连续 seq、同一 at
    const [n, u] = [after[noteIdx], after[userIdx]] as [CoreEvent, CoreEvent]
    expect(u.seq).toBe(n.seq + 1)
    expect(u.at).toBe(n.at)

    // 第 2 次模型请求里可见、顺序一致
    const textOf = (e: Event): string | undefined => {
      const c = e as CoreEvent
      if (c.type === "core.system_note") return c.payload.text
      if (c.type === "core.user_message") return (c.payload.content[0] as { text: string }).text
      return undefined
    }
    const seenTexts = (lowering.requests[1]?.events ?? []).map(textOf).filter((t) => t !== undefined)
    expect(seenTexts.filter((t) => ["go", "background", "change of plan", "p"].includes(t))).toEqual([
      "go",
      "p",
      "background",
      "change of plan",
      "p",
    ])
    // 第 1 次请求还没有
    expect((lowering.requests[0]?.events ?? []).map(textOf)).not.toContain("change of plan")
  })

  it("返回空数组与不传 pullInput：日志逐字相同（回归）", async () => {
    const a = setup()
    await drain(runLoop({ ...a.base, input: "go" }))
    const b = setup()
    await drain(runLoop({ ...b.base, input: "go", pullInput: () => [] }))
    expect(await all(b.log)).toEqual(await all(a.log))
  })

  it("补跑 pending 的那轮不拉：拉到的输入落在补出的 tool_result 之后", async () => {
    const approvalTool = defineTool<Record<string, never>>({
      name: "look",
      description: "",
      inputSchema: { type: "object" },
      risk: "low",
      needsApproval: true,
      execute: () => "looked",
    })
    const { log, base } = setup()
    const cfg = { ...base, tools: [approvalTool] }
    const first = await drain(runLoop({ ...cfg, input: "go" }))
    expect(first.result.status).toBe("paused")

    const { calls, pullInput } = puller({ 1: [user("new info")] })
    const { result } = await drain(
      runLoop({ ...cfg, pullInput, decisions: [{ toolCallId: "c1", approved: true, by: "boss" }] }),
    )
    expect(result.status).toBe("done")
    // 补跑轮不计轮次也不拉；补齐后的第一个模型轮才拉，turn = 1
    expect(calls).toEqual([{ sessionId: SESSION, turn: 1 }])
    const tl = await all(log)
    const resultSeq = tl.find((e) => e.type === "core.tool_result")?.seq ?? 0
    const pulledSeq = tl.filter((e) => e.type === "core.user_message").at(-1)?.seq ?? 0
    expect(pulledSeq).toBeGreaterThan(resultSeq)
  })

  it("已触顶 maxTurns 不拉，照旧 paused(budget)", async () => {
    const { base } = setup(() => ({ drafts: [callTool(`c${Math.random()}`, "look", {})] }))
    const { calls, pullInput } = puller()
    const { result } = await drain(runLoop({ ...base, input: "go", maxTurns: 2, pullInput }))
    expect(result.status).toBe("paused")
    if (result.status === "paused") expect(result.reason).toBe("budget")
    expect(calls.map((c) => c.turn)).toEqual([1, 2])
  })

  it("自然收尾不再拉：一轮 run 只拉一次", async () => {
    const { base } = setup([{ drafts: [say("hi")] }])
    const { calls, pullInput } = puller()
    const { result } = await drain(runLoop({ ...base, input: "go", pullInput }))
    expect(result.status).toBe("done")
    expect(calls).toHaveLength(1)
  })

  it("回调两次返回同一批：照写两次（循环不去重，认领由宿主做）", async () => {
    const { log, base } = setup()
    const same = [user("dup")]
    await drain(runLoop({ ...base, pullInput: () => same }))
    const dups = (await all(log)).filter((e) => e.type === "core.user_message")
    expect(dups).toHaveLength(2)
  })
})

describe("pullInput 中止与失败", () => {
  it("拉取期间宿主中止：拉到的不写，按本轮开始前中止暂停", async () => {
    const { log, base } = setup()
    const controller = new AbortController()
    const { result } = await drain(
      runLoop({
        ...base,
        input: "go",
        signal: controller.signal,
        pullInput: ({ turn }) => {
          if (turn === 2) {
            controller.abort()
            return [user("late")]
          }
          return []
        },
      }),
    )
    expect(result.status).toBe("paused")
    if (result.status === "paused") expect(result.reason).toBe("host")
    const texts = (await all(log))
      .filter((e) => e.type === "core.user_message")
      .map((e) => (e.type === "core.user_message" ? (e.payload.content[0] as { text: string }).text : ""))
    expect(texts).toEqual(["go"])
  })

  it("拉取期间用户停止：同样不写，按停止收尾", async () => {
    const { log, base } = setup()
    const controller = new AbortController()
    const { result } = await drain(
      runLoop({
        ...base,
        input: "go",
        signal: controller.signal,
        pullInput: ({ turn }) => {
          if (turn === 2) {
            controller.abort(new RunStop())
            return [user("late")]
          }
          return []
        },
      }),
    )
    expect(result.status).toBe("paused")
    expect((await all(log)).filter((e) => e.type === "core.user_message")).toHaveLength(1)
  })

  it("回调抛错：记一条 core.error（host、retryable），模型看不到，run 照跑", async () => {
    const { log, lowering, base } = setup()
    const { result } = await drain(
      runLoop({
        ...base,
        input: "go",
        pullInput: ({ turn }) => {
          if (turn === 2) throw new Error("db down")
          return []
        },
      }),
    )
    expect(result.status).toBe("done")
    const errors = (await all(log)).filter((e) => e.type === "core.error")
    expect(errors).toHaveLength(1)
    const err = errors[0]
    if (err?.type !== "core.error") throw new Error("unreachable")
    expect(err.payload).toMatchObject({
      category: "host",
      retryable: true,
      message: "pullInput threw: db down",
      detail: { phase: "pullInput" },
    })
    for (const req of lowering.requests) expect(types(req.events)).not.toContain("error")
  })

  const invalid: [string, unknown][] = [
    ["undefined", undefined],
    ["非数组（单条草稿）", user("x")],
    [
      "core.tool_result",
      [{ type: "core.tool_result", actor: "tool", payload: { toolCallId: "c1", name: "look", content: [] } }],
    ],
    [
      "core.approval_decision",
      [
        {
          type: "core.approval_decision",
          actor: "host",
          payload: { toolCallId: "c1", approved: true, by: "x" },
        },
      ],
    ],
    ["非法 actor", [{ type: "core.user_message", actor: "boss", payload: { content: [] } }]],
    ["未登记的 ext.*", [{ type: "ext.unknown", actor: "host", payload: {} }]],
    ["合规的后面跟一条不合规", [user("ok"), { type: "core.compaction", actor: "model", payload: {} }]],
  ]
  for (const [label, value] of invalid) {
    it(`返回值不合规（${label}）：core.error(input) + status error，这一批一条不写`, async () => {
      const { log, base } = setup()
      const { result } = await drain(
        runLoop({
          ...base,
          input: "go",
          pullInput: ({ turn }) => (turn === 2 ? (value as readonly EventDraft[]) : []),
        }),
      )
      expect(result.status).toBe("error")
      if (result.status === "error") {
        expect(result.error.payload.category).toBe("input")
        expect(result.error.payload.detail).toEqual({ phase: "pullInput" })
      }
      const tl = await all(log)
      expect(tl.filter((e) => e.type === "core.user_message")).toHaveLength(1)
      expect(tl.at(-1)?.type).toBe("core.error")
    })
  }
})
