import { describe, expect, it } from "vitest"
import type { Event } from "../events/base.js"
import { createCoreEvent, type EventDraft } from "../events/create.js"
import { createCoreRegistry } from "../events/registry.js"
import { InMemoryEventLog } from "../store/in-memory.js"
import { callTool, ScriptedLowering, say } from "../testing/scripted-lowering.js"
import { toolBatchOf } from "./batch.js"
import { runLoop } from "./run-loop.js"
import { pendingToolCalls } from "./state.js"
import { defineTool } from "./tools.js"
import type { LoopConfig, RunResult, Socket, Tool, ToolBatch, ToolCallEvent } from "./types.js"

const registry = createCoreRegistry()
const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"

function deterministic() {
  let t = 1_800_000_000_000
  let n = 0
  return { now: () => ++t, newId: () => `id${++n}` }
}

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<RunResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

/** 按 x 的值决定成败：x < 0 抛错、x === 0 返回 isError，其余成功 */
const act = defineTool<{ x: number }>({
  name: "act",
  description: "",
  inputSchema: { type: "object" },
  validate: (a) => {
    if (typeof (a as { x?: unknown }).x !== "number") throw new Error("x must be a number")
    return a as { x: number }
  },
  execute: ({ x }) => {
    if (x < 0) throw new Error("boom")
    if (x === 0) return { content: [{ type: "text", text: "nope" }], isError: true }
    return x
  },
})
const deploy: Tool = {
  name: "deploy",
  description: "",
  inputSchema: {},
  needsApproval: true,
  execute: () => "ok",
}
const pick: Tool = { name: "pick", description: "", inputSchema: {}, side: "client" }

/** ctx.batch 在某个时刻的快照（批本身随落随更，要比较就得拷贝） */
interface Snap {
  where: string
  calls: string[]
  results: string[]
  held: string[]
  resumed: boolean
}
const snapOf = (where: string, b: ToolBatch): Snap => ({
  where,
  calls: b.calls.map((c) => c.payload.toolCallId),
  results: b.results.map((r) => r.payload.toolCallId),
  held: [...b.held],
  resumed: b.resumed,
})

function probe(snaps: Snap[]): Socket {
  return {
    beforeModel: (ctx) => {
      snaps.push(snapOf("beforeModel", ctx.batch))
      return undefined
    },
    beforeTool: (ctx, call) => {
      snaps.push(snapOf(`beforeTool:${call.payload.toolCallId}`, ctx.batch))
      return undefined
    },
    onTurnEnd: (ctx) => {
      snaps.push(snapOf("onTurnEnd", ctx.batch))
      return undefined
    },
  }
}

function config(lowering: ScriptedLowering, log: InMemoryEventLog, extra: Partial<LoopConfig>): LoopConfig {
  return {
    sessionId: SESSION,
    log,
    lowering,
    model: MODEL,
    tools: [act, deploy, pick],
    ...deterministic(),
    ...extra,
  }
}

async function appendDraft(log: InMemoryEventLog, draft: EventDraft): Promise<void> {
  const tailSeq = (await log.tail(SESSION, 1))[0]?.seq ?? 0
  await log.append([createCoreEvent(registry, { ...draft, sessionId: SESSION, seq: tailSeq + 1 } as never)])
}

describe("TurnContext.batch：runLoop 随落随更", () => {
  it("六种结果路径都登记进 results（顺序同日志）；beforeTool 处理第 k 个时只看得见前面落下的", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      {
        drafts: [
          callTool("c1", "act", { x: 1 }), // 成功
          callTool("c2", "act", { x: 0 }), // isError
          callTool("c3", "act", { x: -1 }), // 抛错
          callTool("c4", "act", { y: 1 }), // 入参不合法
          callTool("c5", "nope", {}), // 未知工具
          callTool("c6", "act", { x: 2 }), // block
        ],
      },
      { drafts: [say("done")] },
    ])
    const snaps: Snap[] = []
    const blocker: Socket = {
      beforeTool: (_ctx, call) => (call.payload.toolCallId === "c6" ? { block: "no" } : undefined),
    }
    const result = await drain(
      runLoop(config(lowering, log, { input: "go", sockets: [probe(snaps), blocker] })),
    )
    expect(result.status).toBe("done")
    expect(snaps[0]).toEqual({ where: "beforeModel", calls: [], results: [], held: [], resumed: false })
    const all = ["c1", "c2", "c3", "c4", "c5", "c6"]
    expect(snaps.find((s) => s.where === "beforeTool:c1")).toMatchObject({ calls: all, results: [] })
    expect(snaps.find((s) => s.where === "beforeTool:c4")).toMatchObject({ results: ["c1", "c2", "c3"] })
    expect(snaps.find((s) => s.where === "onTurnEnd")).toEqual({
      where: "onTurnEnd",
      calls: all,
      results: all,
      held: [],
      resumed: false,
    })
  })

  it("审批请求不进 results、进 held；客户端工具同样进 held；审批被拒的结果进 results", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "deploy", {}), callTool("c2", "pick", {}), callTool("c3", "act", { x: 1 })] },
      { drafts: [say("ok")] },
    ])
    const snaps: Snap[] = []
    const cfg = config(lowering, log, { sockets: [probe(snaps)] })
    const first = await drain(runLoop({ ...cfg, input: "go" }))
    expect(first.status).toBe("paused")
    expect(snaps.find((s) => s.where === "beforeTool:c3")).toMatchObject({ results: [], held: ["c1", "c2"] })

    // 续跑：c1 被拒、c2 由宿主回填 —— 补跑轮的批是原批全部，预置已落的
    await appendDraft(log, {
      type: "core.tool_result",
      actor: "tool",
      payload: { toolCallId: "c2", name: "pick", content: [{ type: "text", text: "a.txt" }], isError: false },
    })
    snaps.length = 0
    const second = await drain(
      runLoop({ ...cfg, decisions: [{ sessionId: SESSION, toolCallId: "c1", approved: false, by: "boss" }] }),
    )
    expect(second.status).toBe("done")
    // 审批被拒的调用不经 beforeTool，直接落拒绝结果；补跑轮预置的是上次已落的 c3 与宿主回填的 c2
    expect(snaps.find((s) => s.where === "onTurnEnd")).toEqual({
      where: "onTurnEnd",
      calls: ["c1", "c2", "c3"],
      results: ["c3", "c2", "c1"],
      held: [],
      resumed: true,
    })
  })

  it("批中途中止：正常路径的 onTurnEnd 看到缺结果的批；续跑补跑轮预置上次已落的", async () => {
    const log = new InMemoryEventLog()
    const ac = new AbortController()
    const stopper = defineTool<{ x: number }>({
      name: "stopper",
      description: "",
      inputSchema: { type: "object" },
      execute: () => {
        ac.abort()
        return { content: [{ type: "text", text: "failed" }], isError: true }
      },
    })
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "stopper", { x: 1 }), callTool("c2", "act", { x: 1 })] },
      { drafts: [say("ok")] },
    ])
    const snaps: Snap[] = []
    const cfg = config(lowering, log, { tools: [act, stopper], sockets: [probe(snaps)] })
    const first = await drain(runLoop({ ...cfg, input: "go", signal: ac.signal }))
    expect(first.status).toBe("paused")
    expect(snaps.find((s) => s.where === "onTurnEnd")).toMatchObject({ calls: ["c1", "c2"], results: ["c1"] })

    snaps.length = 0
    await drain(runLoop(cfg))
    expect(snaps.find((s) => s.where === "beforeTool:c2")).toEqual({
      where: "beforeTool:c2",
      calls: ["c1", "c2"],
      results: ["c1"],
      held: [],
      resumed: true,
    })
  })
})

describe("toolBatchOf", () => {
  const ev = (seq: number, draft: EventDraft): Event =>
    createCoreEvent(registry, { ...draft, sessionId: SESSION, seq, id: `e${seq}` } as never)
  const call = (seq: number, id: string): Event => ev(seq, callTool(id, "act", { x: 1 }) as EventDraft)
  const result = (seq: number, id: string): Event =>
    ev(seq, {
      type: "core.tool_result",
      actor: "tool",
      payload: { toolCallId: id, name: "act", content: [], isError: false },
    })
  const user = (seq: number): Event =>
    ev(seq, {
      type: "core.user_message",
      actor: "user",
      payload: { content: [{ type: "text", text: "hi" }] },
    })
  const usage = (seq: number): Event =>
    ev(seq, {
      type: "core.budget_usage",
      actor: "system",
      payload: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, toolCalls: 1, wallMs: 1 },
    })
  const ids = (b: { calls: readonly ToolCallEvent[] }) => b.calls.map((c) => c.payload.toolCallId)

  it("只取遗留调用所在那批；运维事件夹在同一次输出中间不切段；预置这批已落的结果", () => {
    const timeline = [
      user(1),
      call(2, "a1"),
      result(3, "a1"),
      call(4, "b1"),
      usage(5), // TanStack 的 onUsage 早于输出收尾时会夹在中间
      call(6, "b2"),
      call(7, "b3"),
      result(8, "b1"),
    ]
    const located = toolBatchOf(timeline, pendingToolCalls(timeline))
    expect(ids(located)).toEqual(["b1", "b2", "b3"])
    expect(located.results.map((r) => r.payload.toolCallId)).toEqual(["b1"])
  })

  it("pending 为空返回空批；pending 跨多批只取第一批", () => {
    expect(toolBatchOf([user(1)], [])).toEqual({ calls: [], results: [] })
    const timeline = [user(1), call(2, "a1"), user(3), call(4, "b1")]
    expect(ids(toolBatchOf(timeline, pendingToolCalls(timeline)))).toEqual(["a1"])
  })
})
