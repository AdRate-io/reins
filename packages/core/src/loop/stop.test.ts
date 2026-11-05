/**
 * 停止语义与中断不重放（2026-11-05，docs/implementation-plans/2026-11-05-停止语义与中断不重放.md D1 / D2）。
 *
 * D1：用户停止（`abort(new RunStop())`）时，所有暂停出口都把 pending 收尾成 isError 结果，下一个 run 直接问模型；
 *     其它中止原因照旧留 pending、恢复时补跑。
 * D2：不可重放的工具在 execute 之前记 `core.tool_started`；续跑见到"started 无结果"就落"结果未知"、不再执行。
 */
import { describe, expect, it } from "vitest"
import type { Event } from "../events/base.js"
import type { CoreEvent, CoreEventOf } from "../events/core.js"
import { InMemoryEventLog } from "../store/in-memory.js"
import { callTool, ScriptedLowering, type ScriptedTurn, say } from "../testing/scripted-lowering.js"
import { toolBatchOf } from "./batch.js"
import { runLoop, STOPPED_NOTE } from "./run-loop.js"
import { pendingToolCalls } from "./state.js"
import {
  isReplayable,
  isStopReason,
  OUTCOME_UNKNOWN_TEXT,
  RunStop,
  STOPPED_IN_PROGRESS_TEXT,
  STOPPED_NOT_EXECUTED_TEXT,
  startedToolCallIds,
} from "./stop.js"
import { subagentPause } from "./subagent.js"
import { defineTool } from "./tools.js"
import type { LoopConfig, RunResult, Socket, Tool, ToolBatch } from "./types.js"

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

async function all(log: InMemoryEventLog, sessionId = SESSION): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(sessionId)) out.push(e as CoreEvent)
  return out
}

const types = (events: readonly Event[]) => events.map((e) => e.type.replace("core.", ""))

/** 每个 toolCallId 的结果文本 */
async function resultTexts(log: InMemoryEventLog): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const e of await all(log)) {
    if (e.type !== "core.tool_result") continue
    const first = e.payload.content[0]
    out[e.payload.toolCallId] = first?.type === "text" ? first.text : ""
  }
  return out
}

/** 写工具（没声明 risk，即不可重放），记下执行过的入参 */
function writeTool(name: string, executed: string[], onRun?: () => void): Tool {
  return defineTool<{ x: number }>({
    name,
    description: "",
    inputSchema: { type: "object" },
    execute: ({ x }) => {
      executed.push(`${name}:${x}`)
      onRun?.()
      return `${name} ok`
    },
  })
}

function cfgOf(lowering: ScriptedLowering, log: InMemoryEventLog, extra: Partial<LoopConfig>): LoopConfig {
  return { sessionId: SESSION, log, lowering, model: MODEL, ...deterministic(), ...extra }
}

/** 模拟"执行途中进程死亡"：驱动生成器直到看见 tool_started，然后丢掉它（工具的 promise 永不 resolve） */
async function crashDuringTool(cfg: LoopConfig, untilType = "core.tool_started"): Promise<void> {
  const gen = runLoop(cfg)
  while (true) {
    const step = await gen.next()
    if (step.done) throw new Error("expected the run to hang inside the tool")
    if (step.value.type === untilType) {
      // 再推一步让它进到工具里挂住（execute 的 promise 永不 resolve），然后丢掉生成器 = 进程死亡
      void gen.next()
      await new Promise((r) => setTimeout(r, 0))
      return
    }
  }
}

describe("RunStop / isStopReason / isReplayable", () => {
  it("判据看 name 不看 instanceof：另一份 core 造的同名错误也认", () => {
    expect(isStopReason(new RunStop())).toBe(true)
    const foreign = Object.assign(new Error("x"), { name: "RunStop" })
    expect(isStopReason(foreign)).toBe(true)
    expect(isStopReason(new DOMException("aborted", "AbortError"))).toBe(false)
    expect(isStopReason(undefined)).toBe(false)
    expect(isStopReason("RunStop")).toBe(false)
  })

  it("缺省只有 risk: low 可重放；replayable 显式覆盖", () => {
    const base = { name: "t", description: "", inputSchema: {} }
    expect(isReplayable(base)).toBe(false)
    expect(isReplayable({ ...base, risk: "low" })).toBe(true)
    expect(isReplayable({ ...base, risk: "medium" })).toBe(false)
    expect(isReplayable({ ...base, risk: "high", replayable: true })).toBe(true)
    expect(isReplayable({ ...base, risk: "low", replayable: false })).toBe(false)
  })
})

describe("D1：用户停止时收尾 pending（五个暂停出口 × 停止 / 非停止）", () => {
  it("一轮开头：非停止的中止留 pending；之后带 RunStop 的 run 一开头就收尾成'没执行'，下一个 run 直接问模型", async () => {
    const log = new InMemoryEventLog()
    const executed: string[] = []
    const ac = new AbortController()
    const tools = [writeTool("a", executed, () => ac.abort()), writeTool("b", executed)]
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "a", { x: 1 }), callTool("c2", "b", { x: 2 })] },
      { drafts: [say("好，B 先不动")] },
    ])
    // 第一次：丢租约式的普通中止（批中途），c2 留作 pending
    const first = await drain(
      runLoop(cfgOf(lowering, log, { tools, signal: ac.signal, input: "改 A 再停 B" })),
    )
    expect(first.result.status === "paused" && first.result.state.pendingToolCallIds).toEqual(["c2"])

    // 第二次：用户点停止（空闲 STOP 起的收尾 run：signal 预先就是 RunStop）
    const stop = new AbortController()
    stop.abort(new RunStop())
    const second = await drain(runLoop(cfgOf(lowering, log, { tools, signal: stop.signal })))
    expect(second.result).toMatchObject({
      status: "paused",
      reason: "host",
      interruptions: [{ kind: "host", note: STOPPED_NOTE }],
    })
    if (second.result.status !== "paused") return
    expect(second.result.state.pendingToolCallIds).toEqual([])
    expect(executed).toEqual(["a:1"])
    expect((await resultTexts(log)).c2).toBe(STOPPED_NOT_EXECUTED_TEXT)
    // 收尾结果排在 run_paused 之前，且是 isError
    const tail = (await all(log)).slice(-2)
    expect(types(tail)).toEqual(["tool_result", "run_paused"])
    expect((tail[0] as CoreEventOf<"core.tool_result">).payload.isError).toBe(true)

    // 第三次：用户的新话进来，循环直接问模型，不再补跑 c2
    const third = await drain(runLoop(cfgOf(lowering, log, { tools, input: "B 先别停" })))
    expect(third.result.status).toBe("done")
    expect(executed).toEqual(["a:1"])
    expect(lowering.requests).toHaveLength(2)
  })

  it("重试等待时：停止收尾并 paused(host, stopped by the user)；非停止仍是 'host aborted while waiting to retry'", async () => {
    for (const reason of [new RunStop(), undefined]) {
      const log = new InMemoryEventLog()
      const ac = new AbortController()
      const lowering = new ScriptedLowering([{ drafts: [], throws: new Error("fetch failed") }])
      const { result } = await drain(
        runLoop(
          cfgOf(lowering, log, {
            input: "hi",
            signal: ac.signal,
            retry: { sleep: async () => ac.abort(reason) },
          }),
        ),
      )
      expect(result).toMatchObject({ status: "paused", reason: "host" })
      if (result.status !== "paused") continue
      expect(result.interruptions[0]).toEqual({
        kind: "host",
        note: reason ? STOPPED_NOTE : "host aborted while waiting to retry",
      })
    }
  })

  it("模型回复中途：已完整的 tool_call 停止时落'没执行'；非停止留 pending", async () => {
    for (const stop of [true, false]) {
      const log = new InMemoryEventLog()
      const ac = new AbortController()
      const executed: string[] = []
      const lowering = new ScriptedLowering(() => {
        ac.abort(stop ? new RunStop() : undefined)
        return { drafts: [callTool("c1", "a", { x: 1 })], outcome: { stopReason: "aborted" } }
      })
      const { result } = await drain(
        runLoop(cfgOf(lowering, log, { tools: [writeTool("a", executed)], input: "go", signal: ac.signal })),
      )
      expect(result.status).toBe("paused")
      if (result.status !== "paused") continue
      expect(executed).toEqual([])
      if (stop) {
        expect(result.state.pendingToolCallIds).toEqual([])
        expect((await resultTexts(log)).c1).toBe(STOPPED_NOT_EXECUTED_TEXT)
      } else {
        expect(result.state.pendingToolCallIds).toEqual(["c1"])
        expect(result.interruptions[0]).toEqual({ kind: "host", note: "host aborted the model response" })
      }
    }
  })

  it("工具批之后：批里有等审批的、正在执行的被停止、后面的没轮到——等审批与没轮到的都落'没执行'，执行完的落真实结果", async () => {
    const log = new InMemoryEventLog()
    const ac = new AbortController()
    const executed: string[] = []
    const gated: Tool = { ...writeTool("gated", executed), needsApproval: true }
    const tools = [gated, writeTool("a", executed, () => ac.abort(new RunStop())), writeTool("b", executed)]
    const lowering = new ScriptedLowering([
      {
        drafts: [
          callTool("c0", "gated", { x: 0 }),
          callTool("c1", "a", { x: 1 }),
          callTool("c2", "b", { x: 2 }),
        ],
      },
    ])
    const { result } = await drain(runLoop(cfgOf(lowering, log, { tools, input: "go", signal: ac.signal })))
    expect(result).toMatchObject({ status: "paused", reason: "host" })
    if (result.status !== "paused") return
    expect(result.state.pendingToolCallIds).toEqual([])
    expect(executed).toEqual(["a:1"])
    expect(await resultTexts(log)).toEqual({
      c0: STOPPED_NOT_EXECUTED_TEXT,
      c1: "a ok",
      c2: STOPPED_NOT_EXECUTED_TEXT,
    })
  })

  it("工具批中途停止时不进 onTurnEnd：Socket 判 stop 也不会让 pending 带进 done", async () => {
    const log = new InMemoryEventLog()
    const ac = new AbortController()
    const executed: string[] = []
    let turnEnds = 0
    const finisher: Socket = {
      onTurnEnd() {
        turnEnds++
        return "stop"
      },
    }
    const tools = [writeTool("a", executed, () => ac.abort(new RunStop())), writeTool("b", executed)]
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "a", { x: 1 }), callTool("c2", "b", { x: 2 })] },
    ])
    const { result } = await drain(
      runLoop(cfgOf(lowering, log, { tools, sockets: [finisher], input: "go", signal: ac.signal })),
    )
    expect(result.status).toBe("paused")
    expect(turnEnds).toBe(0)
    expect((await resultTexts(log)).c2).toBe(STOPPED_NOT_EXECUTED_TEXT)
  })

  it("补跑时：补跑途中被停止，余下的 pending 收尾，不进 onTurnEnd", async () => {
    const log = new InMemoryEventLog()
    const first = new AbortController()
    const executed: string[] = []
    let stopNow: (() => void) | undefined
    const tools = [
      writeTool("a", executed, () => first.abort()),
      writeTool("b", executed, () => stopNow?.()),
      writeTool("c", executed),
    ]
    const lowering = new ScriptedLowering([
      {
        drafts: [callTool("c1", "a", { x: 1 }), callTool("c2", "b", { x: 2 }), callTool("c3", "c", { x: 3 })],
      },
    ])
    await drain(runLoop(cfgOf(lowering, log, { tools, input: "go", signal: first.signal })))
    expect(pendingToolCalls(await all(log)).map((c) => c.payload.toolCallId)).toEqual(["c2", "c3"])

    let turnEnds = 0
    const counter: Socket = {
      onTurnEnd() {
        turnEnds++
        return undefined
      },
    }
    const second = new AbortController()
    stopNow = () => second.abort(new RunStop())
    const { result } = await drain(
      runLoop(cfgOf(lowering, log, { tools, sockets: [counter], signal: second.signal })),
    )
    expect(result).toMatchObject({ status: "paused", reason: "host" })
    expect(turnEnds).toBe(0)
    expect(executed).toEqual(["a:1", "b:2"])
    expect(await resultTexts(log)).toMatchObject({ c2: "b ok", c3: STOPPED_NOT_EXECUTED_TEXT })
  })

  it("客户端工具的 pending 也被收尾", async () => {
    const log = new InMemoryEventLog()
    const picker: Tool = { name: "pick", description: "", inputSchema: {}, side: "client" }
    const lowering = new ScriptedLowering([{ drafts: [callTool("c1", "pick", {})] }])
    const first = await drain(runLoop(cfgOf(lowering, log, { tools: [picker], input: "选一个" })))
    expect(first.result.status === "paused" && first.result.state.pendingToolCallIds).toEqual(["c1"])
    const stop = new AbortController()
    stop.abort(new RunStop())
    await drain(runLoop(cfgOf(lowering, log, { tools: [picker], signal: stop.signal })))
    expect((await resultTexts(log)).c1).toBe(STOPPED_NOT_EXECUTED_TEXT)
  })

  it("有 started 的写工具（上一个进程执行中死掉）停止时落'结果未知'；做了一半的子代理落 Interrupted", async () => {
    const log = new InMemoryEventLog()
    const hang: Tool = {
      name: "hang",
      description: "",
      inputSchema: {},
      execute: () => new Promise(() => {}),
    }
    const lowering = new ScriptedLowering([{ drafts: [callTool("c1", "hang", {})] }])
    await crashDuringTool(cfgOf(lowering, log, { tools: [hang], input: "go" }))
    const stop = new AbortController()
    stop.abort(new RunStop())
    await drain(runLoop(cfgOf(lowering, log, { tools: [hang], signal: stop.signal })))
    expect((await resultTexts(log)).c1).toBe(OUTCOME_UNKNOWN_TEXT)

    // 子代理：返回 subagentPause 后补写了 started，父被停止时落"做了一半"
    const log2 = new InMemoryEventLog()
    const ac = new AbortController()
    const expert: Tool = {
      name: "ask",
      description: "",
      inputSchema: {},
      replayable: true,
      execute: () => {
        ac.abort(new RunStop())
        return subagentPause({
          childSessionId: "child",
          reason: "host",
          interruptions: [],
          state: {
            v: 1,
            sessionId: "child",
            lastSeq: 1,
            pendingToolCallIds: [],
            configHash: "h",
            pendingDigest: "d",
          },
        })
      },
    }
    const lowering2 = new ScriptedLowering([{ drafts: [callTool("p1", "ask", {})] }])
    const { result } = await drain(
      runLoop(cfgOf(lowering2, log2, { tools: [expert], input: "go", signal: ac.signal })),
    )
    expect(result).toMatchObject({
      status: "paused",
      reason: "host",
      interruptions: [{ note: STOPPED_NOTE }],
    })
    expect(types(await all(log2))).toEqual([
      "tools_bound",
      "user_message",
      "tool_call",
      "tool_started",
      "budget_usage",
      "tool_result",
      "run_paused",
    ])
    expect((await resultTexts(log2)).p1).toBe(STOPPED_IN_PROGRESS_TEXT)
  })

  it("连接阶段被中止（fetch 抛出 signal.reason）：以 paused(host) 结束而不是 error；RunStop 与普通 AbortError 都是", async () => {
    for (const stop of [true, false]) {
      const log = new InMemoryEventLog()
      const ac = new AbortController()
      const lowering = new ScriptedLowering((): ScriptedTurn => {
        ac.abort(stop ? new RunStop() : undefined)
        return { drafts: [], throws: ac.signal.reason as Error }
      })
      const { result } = await drain(runLoop(cfgOf(lowering, log, { input: "hi", signal: ac.signal })))
      expect(result).toMatchObject({ status: "paused", reason: "host" })
      if (result.status !== "paused") continue
      expect(result.interruptions[0]?.kind === "host" && result.interruptions[0].note).toBe(
        stop ? STOPPED_NOTE : "host aborted the model request",
      )
      expect(types(await all(log))).not.toContain("error")
      expect(lowering.requests).toHaveLength(1)
    }
  })
})

describe("D2：中断后写工具不重放", () => {
  it("写工具执行途中进程死亡：续跑不再执行，落'结果未知'，模型据此决定", async () => {
    const log = new InMemoryEventLog()
    let calls = 0
    const budget: Tool = {
      name: "set_budget",
      description: "",
      inputSchema: {},
      execute: () => {
        calls++
        return calls === 1 ? new Promise(() => {}) : "changed"
      },
    }
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "set_budget", { amount: 200 })] },
      { drafts: [say("我先查一下 A 的预算")] },
    ])
    await crashDuringTool(cfgOf(lowering, log, { tools: [budget], input: "A 改 200" }))
    expect(calls).toBe(1)
    expect(types(await all(log))).toEqual(["tools_bound", "user_message", "tool_call", "tool_started"])

    const { result } = await drain(runLoop(cfgOf(lowering, log, { tools: [budget] })))
    expect(result.status).toBe("done")
    expect(calls).toBe(1)
    expect((await resultTexts(log)).c1).toBe(OUTCOME_UNKNOWN_TEXT)
    // 模型看到的是"结果未知"那条 isError 结果
    const seen = lowering.requests[1]?.events.find((e) => e.type === "core.tool_result") as
      | CoreEventOf<"core.tool_result">
      | undefined
    expect(seen?.payload).toMatchObject({
      isError: true,
      content: [{ type: "text", text: OUTCOME_UNKNOWN_TEXT }],
    })
  })

  it("只读工具不写 started、崩溃后照旧重放；replayable: true 覆盖 risk", async () => {
    for (const tool of [{ risk: "low" as const }, { risk: "high" as const, replayable: true }]) {
      const log = new InMemoryEventLog()
      let calls = 0
      const read: Tool = {
        name: "read",
        description: "",
        inputSchema: {},
        ...tool,
        execute: () => {
          calls++
          return calls === 1 ? new Promise(() => {}) : "data"
        },
      }
      const lowering = new ScriptedLowering([
        { drafts: [callTool("c1", "read", {})] },
        { drafts: [say("读到了")] },
      ])
      // 没有 started 可等：工具一开跑就挂住，drain 到 tool_call 后放弃
      await crashDuringTool(cfgOf(lowering, log, { tools: [read], input: "读" }), "core.tool_call")
      expect(calls).toBe(1)
      expect(types(await all(log))).not.toContain("tool_started")
      const { result } = await drain(runLoop(cfgOf(lowering, log, { tools: [read] })))
      expect(result.status).toBe("done")
      expect(calls).toBe(2)
      expect((await resultTexts(log)).c1).toBe("data")
    }
  })

  it("工具不在表里了：判不出能不能重放，按不可重放落'结果未知'", async () => {
    const log = new InMemoryEventLog()
    const hang: Tool = {
      name: "hang",
      description: "",
      inputSchema: {},
      execute: () => new Promise(() => {}),
    }
    const lowering = new ScriptedLowering([{ drafts: [callTool("c1", "hang", {})] }, { drafts: [say("ok")] }])
    await crashDuringTool(cfgOf(lowering, log, { tools: [hang], input: "go" }))
    await drain(runLoop(cfgOf(lowering, log, { tools: [] })))
    expect((await resultTexts(log)).c1).toBe(OUTCOME_UNKNOWN_TEXT)
  })

  it("感知 signal 的写工具被掐断：落'结果未知'而不是 Tool execution failed；只读工具照旧落失败", async () => {
    for (const risk of [undefined, "low" as const]) {
      const log = new InMemoryEventLog()
      const ac = new AbortController()
      const aware: Tool = {
        name: "aware",
        description: "",
        inputSchema: {},
        ...(risk ? { risk } : {}),
        execute: (_input, ctx) => {
          ac.abort()
          throw ctx.signal?.reason ?? new Error("aborted")
        },
      }
      const lowering = new ScriptedLowering([{ drafts: [callTool("c1", "aware", {})] }])
      await drain(runLoop(cfgOf(lowering, log, { tools: [aware], input: "go", signal: ac.signal })))
      const text = (await resultTexts(log)).c1
      if (risk) expect(text).toMatch(/^Tool execution failed/)
      else expect(text).toBe(OUTCOME_UNKNOWN_TEXT)
    }
  })

  it("tool_started 模型不可见、不切批：补跑时 ctx.batch.calls 仍是同一批的全部调用", async () => {
    const log = new InMemoryEventLog()
    const ac = new AbortController()
    const executed: string[] = []
    const tools = [writeTool("a", executed, () => ac.abort()), writeTool("b", executed)]
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "a", { x: 1 }), callTool("c2", "b", { x: 2 })] },
      { drafts: [say("完")] },
    ])
    await drain(runLoop(cfgOf(lowering, log, { tools, input: "go", signal: ac.signal })))
    const timeline = await all(log)
    expect(types(timeline)).toContain("tool_started")
    const located = toolBatchOf(timeline, pendingToolCalls(timeline))
    expect(located.calls.map((c) => c.payload.toolCallId)).toEqual(["c1", "c2"])
    expect(startedToolCallIds(timeline)).toEqual(new Set(["c1"]))

    let seen: ToolBatch | undefined
    const spy: Socket = {
      beforeTool(ctx) {
        seen = { ...ctx.batch, calls: [...ctx.batch.calls] }
        return undefined
      },
    }
    await drain(runLoop(cfgOf(lowering, log, { tools, sockets: [spy] })))
    expect(seen?.resumed).toBe(true)
    expect(seen?.calls.map((c) => c.payload.toolCallId)).toEqual(["c1", "c2"])
    expect(executed).toEqual(["a:1", "b:2"])
    // 模型看到的请求里没有 tool_started
    expect(lowering.requests[1]?.events.map((e) => e.type)).not.toContain("core.tool_started")
  })
})
