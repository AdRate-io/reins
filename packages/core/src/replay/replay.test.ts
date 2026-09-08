import { describe, expect, it } from "vitest"
import type { Event } from "../events/base.js"
import type { CoreEventPayloads, CoreEventType } from "../events/core.js"
import { createCoreEvent, type EventDraft } from "../events/create.js"
import { createCoreRegistry } from "../events/registry.js"
import { runLoop } from "../loop/run-loop.js"
import { defineTool } from "../loop/tools.js"
import type { LoopConfig, RunResult, Tool } from "../loop/types.js"
import { InMemoryEventLog } from "../store/in-memory.js"
import { callTool, ScriptedLowering, say, think } from "../testing/scripted-lowering.js"
import { replayTurns } from "./replay.js"

/**
 * replayTurns 的唯一承诺：只凭日志重算出的"第 n 轮可见事件"，与当时真正发给模型的逐字相同。
 * ScriptedLowering 记下了每次 toRequest 的输入，正好是"当时真正发的"。
 */

const registry = createCoreRegistry()
const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "replay-s1"
const BUDGET = { contextLimit: 200_000 }

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

const deployTool: Tool = {
  name: "deploy",
  description: "上线",
  inputSchema: { type: "object" },
  needsApproval: true,
  execute: () => "已上线",
}

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<RunResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

async function all(log: InMemoryEventLog, sessionId = SESSION): Promise<Event[]> {
  const out: Event[] = []
  for await (const e of log.read(sessionId)) out.push(e)
  return out
}

const ids = (events: readonly Event[]) => events.map((e) => e.id)
const types = (events: readonly Event[]) => events.map((e) => e.type.replace("core.", ""))

function baseConfig(
  lowering: ScriptedLowering,
  log: InMemoryEventLog,
  extra: Partial<LoopConfig> = {},
): LoopConfig {
  return { sessionId: SESSION, log, lowering, model: MODEL, tools: [addTool], ...deterministic(), ...extra }
}

describe("replayTurns：只凭日志重算每轮模型看到了什么", () => {
  it("三轮带工具：每轮 visible 与当时发给模型的逐字相同，output / aftermath / usage 各归其位", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [think("先算 2+3"), callTool("c1", "add", { a: 2, b: 3 })] },
      { drafts: [callTool("c2", "add", { a: 5, b: 4 })], outcome: { usage: { input: 42, output: 7 } } },
      { drafts: [say("答案是 9")] },
    ])
    await drain(runLoop(baseConfig(lowering, log, { input: "2+3 再加 4 等于几？" })))
    const timeline = await all(log)

    const { turns, preamble } = replayTurns(timeline, { budget: BUDGET })

    expect(types(preamble)).toEqual(["user_message"])
    expect(turns).toHaveLength(3)
    // 核心承诺
    expect(turns.map((t) => ids(t.visible))).toEqual(lowering.requests.map((r) => ids(r.events)))
    expect(turns.every((t) => !t.diverged)).toBe(true)

    expect(turns.map((t) => t.requestAtSeq)).toEqual([1, 5, 8])
    expect(turns.map((t) => types(t.output))).toEqual([
      ["model_thinking", "tool_call"],
      ["tool_call"],
      ["model_text"],
    ])
    expect(turns.map((t) => types(t.aftermath))).toEqual([
      ["tool_result", "budget_usage"],
      ["tool_result", "budget_usage"],
      ["budget_usage"],
    ])
    expect(turns[1]?.usage?.tokens).toEqual({ input: 42, output: 7 })
    expect(turns[1]?.usage?.toolCalls).toBe(1)
    // 统计来自投影：第三轮看到 7 条（用户 → 想 → 调 → 果 → 调 → 果 → 答 之前的 6 条 + 用户消息）
    expect(turns[2]?.stats.estimatedTokens).toBeGreaterThan(0)
    expect(turns[2]?.visible).toHaveLength(6)
    // preamble + 各轮 output + aftermath 拼回去就是整条时间线，一条不多一条不少
    const rebuilt = [...preamble, ...turns.flatMap((t) => [...t.output, ...t.aftermath])]
    expect(ids(rebuilt)).toEqual(ids(timeline))
  })

  it("审批暂停再恢复：暂停期间的 run_paused / approval_decision / run_resumed 归入前一轮的 aftermath，恢复后的那轮 visible 仍与实际一致", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "deploy", { env: "prod" })] },
      { drafts: [say("上线完成")] },
    ])
    const cfg = baseConfig(lowering, log, { tools: [deployTool] })
    const first = await drain(runLoop({ ...cfg, input: "上线到 prod" }))
    expect(first.status).toBe("paused")
    if (first.status !== "paused") return
    const second = await drain(
      runLoop({ ...cfg, resume: first.state, decisions: [{ toolCallId: "c1", approved: true, by: "boss" }] }),
    )
    expect(second.status).toBe("done")
    const timeline = await all(log)

    const { turns } = replayTurns(timeline, { budget: BUDGET })
    expect(turns).toHaveLength(2)
    expect(turns.map((t) => ids(t.visible))).toEqual(lowering.requests.map((r) => ids(r.events)))
    expect(types(turns[0]?.aftermath ?? [])).toEqual([
      "approval_request",
      "budget_usage",
      "run_paused",
      "run_resumed",
      "approval_decision",
      "tool_result",
    ])
    // 第二轮模型看到的里有审批相关事件吗？由投影的可见性规则决定，回放只是如实重算
    expect(types(turns[1]?.visible ?? [])).toEqual(types(lowering.requests[1]?.events ?? []))
  })

  it("日志里已有 compaction：重算按同一规则折叠，diverged 为 false；换一套会新造事件的策略则 diverged 为 true", async () => {
    // 手工造一条含 compaction 的时间线：用户问 → 模型答 → 压缩覆盖 1~2 → 用户再问 → 模型再答
    const at = 1_800_000_000_000
    const mk = <T extends CoreEventType>(seq: number, draft: EventDraft<T, CoreEventPayloads[T]>): Event =>
      createCoreEvent(registry, { ...draft, sessionId: SESSION, seq, at: at + seq, id: `e${seq}` })
    const timeline: Event[] = [
      mk(1, {
        type: "core.user_message",
        actor: "user",
        payload: { content: [{ type: "text", text: "第一问" }] },
      }),
      mk(2, { type: "core.model_text", actor: "model", payload: { text: "第一答" } }),
      mk(3, {
        type: "core.compaction",
        actor: "system",
        payload: {
          coversSeq: [1, 2],
          summary: "用户问了第一问，我答了第一答",
          decidedBy: "model",
          pinsKept: [],
        },
      }),
      mk(4, {
        type: "core.user_message",
        actor: "user",
        payload: { content: [{ type: "text", text: "第二问" }] },
      }),
      mk(5, { type: "core.model_text", actor: "model", payload: { text: "第二答" } }),
    ]

    const { turns } = replayTurns(timeline, { budget: BUDGET })
    expect(turns).toHaveLength(2)
    expect(turns[0]?.diverged).toBe(false)
    expect(turns[1]?.diverged).toBe(false)
    // 第二轮看到的是折叠后的摘要 + 第二问，不再有第一问原文
    expect(types(turns[1]?.visible ?? [])).toEqual(["compaction", "user_message"])

    // 注入一个总会新造事件的策略：当时没发生过这件事 → 标记 diverged，让使用者知道这不是当时的事实
    const noisy = {
      name: "noisy",
      apply: (
        events: readonly Event[],
        ctx: { nextSeq(): number; now: number; newId(at: number): string },
      ) => {
        const extra = createCoreEvent(registry, {
          type: "core.system_note",
          actor: "system",
          sessionId: SESSION,
          seq: ctx.nextSeq(),
          at: ctx.now,
          id: ctx.newId(ctx.now),
          payload: { kind: "host", text: "回放时才有的提示" },
        })
        return { events: [...events, extra], emitted: [extra] }
      },
    }
    const diverged = replayTurns(timeline, { budget: BUDGET, strategies: [noisy] })
    expect(diverged.turns.every((t) => t.diverged)).toBe(true)
    // 且重算不会去改日志：输入的时间线原样
    expect(timeline).toHaveLength(5)
  })

  it("空时间线与只有用户消息的时间线：没有轮次，全部进 preamble", () => {
    expect(replayTurns([], { budget: BUDGET })).toEqual({ turns: [], preamble: [] })
    const only = createCoreEvent(registry, {
      type: "core.user_message",
      actor: "user",
      sessionId: SESSION,
      seq: 1,
      at: 1,
      id: "e1",
      payload: { content: [{ type: "text", text: "还没人回" }] },
    })
    const r = replayTurns([only], { budget: BUDGET })
    expect(r.turns).toEqual([])
    expect(ids(r.preamble)).toEqual(["e1"])
  })
})
