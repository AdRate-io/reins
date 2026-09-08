import {
  type CoreEvent,
  defineTool,
  type Event,
  InMemoryEventLog,
  type LoopConfig,
  type RunResult,
  runLoop,
  type Socket,
  type TurnContext,
} from "@reins/core"
import { callTool, ScriptedLowering, type ScriptedTurn, say } from "@reins/core/testing"
import { describe, expect, it } from "vitest"
import { handoff } from "../handoff/index.js"
import { assertLimits, budget, budgetUsedOf, checkBudget, defaultBudgetNote } from "./budget.js"

const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"

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

/** 三轮：两轮工具调用 + 一轮收尾；每轮用量固定 input 10 / output 5 */
const THREE_TURNS: ScriptedTurn[] = [
  { drafts: [callTool("c1", "add", { a: 2, b: 3 })] },
  { drafts: [callTool("c2", "add", { a: 5, b: 4 })] },
  { drafts: [say("答案是 9")] },
]

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
    input: "算",
    ...deterministic(),
    ...extra,
  }
}

function pausedBudget(result: RunResult): string {
  expect(result.status).toBe("paused")
  if (result.status !== "paused") throw new Error("unreachable")
  expect(result.reason).toBe("budget")
  expect(result.interruptions).toHaveLength(1)
  const i = result.interruptions[0]
  if (i?.kind !== "budget") throw new Error("unreachable")
  return i.note
}

const fakeBudget = (over: Partial<TurnContext["budget"]> = {}): TurnContext["budget"] => ({
  contextLimit: 200_000,
  targetTokens: 170_000,
  used: 1000,
  tokensSpent: 0,
  turns: 0,
  toolCalls: 0,
  wallMs: 0,
  ...over,
})

describe("budget：纯函数", () => {
  it("上限必须是正的有限数", () => {
    expect(() => assertLimits({ totalTokens: 100, turns: 1 })).not.toThrow()
    expect(() => assertLimits({})).not.toThrow()
    expect(() => assertLimits({ totalTokens: 0 })).toThrow(RangeError)
    expect(() => assertLimits({ turns: -1 })).toThrow(RangeError)
    expect(() => assertLimits({ wallMs: Number.POSITIVE_INFINITY })).toThrow(RangeError)
    expect(() => budget({ limits: { toolCalls: Number.NaN } })).toThrow(RangeError)
  })

  it("用量：contextTokens 取最近一次请求的 input + 缓存读写，没请求过就没有", () => {
    expect(budgetUsedOf(fakeBudget()).contextTokens).toBeUndefined()
    const used = budgetUsedOf(
      fakeBudget({
        lastUsage: { input: 1000, output: 50, cacheRead: 8000, cacheWrite: 500 },
        tokensSpent: 2000,
        turns: 3,
        toolCalls: 4,
        wallMs: 5000,
      }),
    )
    expect(used).toEqual({ contextTokens: 9500, totalTokens: 2000, turns: 3, toolCalls: 4, wallMs: 5000 })
  })

  it("触顶 = 用量 ≥ 上限；只查给了的维度；按字段顺序列出全部触顶项", () => {
    const b = fakeBudget({
      lastUsage: { input: 100, output: 1 },
      tokensSpent: 200,
      turns: 5,
      toolCalls: 9,
      wallMs: 60,
    })
    expect(checkBudget(b, {})).toEqual([])
    expect(checkBudget(b, { totalTokens: 201, turns: 6 })).toEqual([])
    expect(checkBudget(b, { totalTokens: 200 })).toEqual([
      { dimension: "totalTokens", used: 200, limit: 200 },
    ])
    expect(checkBudget(b, { contextTokens: 50, toolCalls: 3, wallMs: 1000 })).toEqual([
      { dimension: "contextTokens", used: 100, limit: 50 },
      { dimension: "toolCalls", used: 9, limit: 3 },
    ])
    // 还没请求过：contextTokens 上限再小也不算触顶
    expect(checkBudget(fakeBudget(), { contextTokens: 1 })).toEqual([])
  })

  it("缺省说明列出触顶维度与用量/上限", () => {
    const note = defaultBudgetNote([
      { dimension: "totalTokens", used: 213_000, limit: 200_000 },
      { dimension: "toolCalls", used: 51, limit: 50 },
    ])
    expect(note).toContain("totalTokens 213000/200000, toolCalls 51/50")
    expect(note).toContain("fresh run budget")
  })
})

describe("budget × runLoop", () => {
  it("totalTokens 触顶且模型还要继续 → paused(budget)，note 说明维度；本轮工具结果已入日志", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering(THREE_TURNS)
    // 每轮 15 token：第一轮 15 < 20，第二轮累计 30 ≥ 20 → 第二轮结束时暂停
    const { result } = await drain(
      runLoop(config(lowering, log, { sockets: [budget({ limits: { totalTokens: 20 } })] })),
    )
    const note = pausedBudget(result)
    expect(note).toContain("totalTokens 30/20")
    expect(lowering.requests).toHaveLength(2)
    const tl = types(await all(log))
    expect(tl.slice(-3)).toEqual(["tool_result", "budget_usage", "run_paused"])
  })

  it("模型已收尾作答的轮不拦：用量早已超限，run 仍是 done", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [say("直接回答")] }])
    const { result } = await drain(
      runLoop(config(lowering, log, { sockets: [budget({ limits: { totalTokens: 1 } })] })),
    )
    expect(result.status).toBe("done")
  })

  it("turns / toolCalls / wallMs 各自触顶", async () => {
    const run = async (limits: Parameters<typeof budget>[0]["limits"]) => {
      const log = new InMemoryEventLog()
      const lowering = new ScriptedLowering(THREE_TURNS)
      const { result } = await drain(runLoop(config(lowering, log, { sockets: [budget({ limits })] })))
      return { result, requests: lowering.requests.length }
    }
    const turns = await run({ turns: 1 })
    expect(pausedBudget(turns.result)).toContain("turns 1/1")
    expect(turns.requests).toBe(1)

    const calls = await run({ toolCalls: 2 })
    expect(pausedBudget(calls.result)).toContain("toolCalls 2/2")
    expect(calls.requests).toBe(2)

    // deterministic() 的时钟每次读数 +1ms，第一轮结束时距 run 开始已有若干毫秒
    const wall = await run({ wallMs: 2 })
    expect(pausedBudget(wall.result)).toMatch(/wallMs \d+\/2/)
    expect(wall.requests).toBe(1)
  })

  it("contextTokens 按最近一次请求的真实上下文（input + 缓存读写）", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "add", { a: 1, b: 1 })], outcome: { usage: { input: 100, output: 5 } } },
      {
        drafts: [callTool("c2", "add", { a: 1, b: 1 })],
        outcome: { usage: { input: 100, output: 5, cacheRead: 900, cacheWrite: 50 } },
      },
      { drafts: [say("好")] },
    ])
    const { result } = await drain(
      runLoop(config(lowering, log, { sockets: [budget({ limits: { contextTokens: 1000 } })] })),
    )
    expect(pausedBudget(result)).toContain("contextTokens 1050/1000")
    expect(lowering.requests).toHaveLength(2)
  })

  it("多维同时触顶一起列出；自定义 note", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering(THREE_TURNS)
    const { result } = await drain(
      runLoop(
        config(lowering, log, {
          sockets: [
            budget({
              limits: { totalTokens: 15, turns: 1 },
              note: (hits) => `超了：${hits.map((h) => h.dimension).join("+")}`,
            }),
          ],
        }),
      ),
    )
    expect(pausedBudget(result)).toBe("超了：totalTokens+turns")
  })

  it("续跑即再批一份预算：同一会话再起 runLoop，从零计，跑到 done", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering(THREE_TURNS)
    const cfg = config(lowering, log, { sockets: [budget({ limits: { turns: 2 } })] })
    const first = await drain(runLoop(cfg))
    expect(pausedBudget(first.result)).toContain("turns 2/2")

    if (first.result.status !== "paused") throw new Error("unreachable")
    const { input: _input, ...resumeCfg } = cfg
    const second = await drain(runLoop({ ...resumeCfg, resume: first.result.state }))
    expect(second.result.status).toBe("done")
    expect(lowering.requests).toHaveLength(3)
    const tl = types(await all(log))
    expect(tl.filter((t) => t === "run_paused")).toHaveLength(1)
    expect(tl.filter((t) => t === "run_resumed")).toHaveLength(1)
  })

  it("排在 handoff 之后：模型已决定交接就交接，不被预算暂停打断", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      {
        drafts: [
          callTool("h1", "handoff", { summary: "先做到这", nextSteps: ["继续"], triggerMessage: "接着算" }),
        ],
      },
    ])
    const sockets: Socket[] = [handoff(), budget({ limits: { totalTokens: 1 } })]
    const { result } = await drain(runLoop(config(lowering, log, { sockets })))
    expect(result.status).toBe("handoff")
  })
})
