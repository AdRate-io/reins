import {
  type CoreEvent,
  type CoreEventOf,
  createCoreEvent,
  createCoreRegistry,
  defineTool,
  type Event,
  type EventDraft,
  InMemoryEventLog,
  type LoopConfig,
  type RunResult,
  runLoop,
  type TurnContext,
} from "@reins/core"
import { callTool, ScriptedLowering, type ScriptedTurn, say, think } from "@reins/core/testing"
import { describe, expect, it } from "vitest"
import { lastVisiblePerceptionNote, perception } from "./perception.js"
import { contextOverheadOf, readPerception } from "./reading.js"
import { renderPerception } from "./render.js"
import { compactNumber, countTier, rangeTier } from "./tiers.js"

const registry = createCoreRegistry()
const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"
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

/** 三轮剧本：想 → 调工具 → 再调工具 → 回答 */
const THREE_TURNS: ScriptedTurn[] = [
  { drafts: [think("先算 2+3"), callTool("c1", "add", { a: 2, b: 3 })] },
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

const notesOf = (events: readonly Event[]): Note[] =>
  events.filter((e): e is Note => e.type === "core.system_note" && (e as Note).payload.kind === "perception")

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
    systemPrompt: "你是计算器",
    input: "2+3 再加 4 等于几？",
    ...deterministic(),
    ...extra,
  }
}

describe("perception × runLoop：注入位置与 prompt cache 约束", () => {
  it("首轮在 user 消息之后、模型输出之前追加一条 perception 说明，带结构化读数；不动系统提示与工具表", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering(THREE_TURNS)
    const { result } = await drain(runLoop(config(lowering, log, { sockets: [perception()] })))
    expect(result.status).toBe("done")

    const logged = await all(log)
    expect(logged.slice(0, 3).map((e) => e.type)).toEqual([
      "core.user_message",
      "core.system_note",
      "core.model_thinking",
    ])
    const note = logged[1] as Note
    expect(note.actor).toBe("system")
    expect(note.payload.kind).toBe("perception")
    expect(note.payload.text).toContain("Context window used: <50%")
    expect(note.payload.text).toContain("auto-folds the oldest turns at 85%")
    expect(note.payload.text).toContain(
      "Unfolded history: ≤5 turns; compactions so far: 0 (nothing has been folded; everything above is verbatim)",
    )
    expect(note.payload.text).toContain("Session tokens used: <10k")
    expect(note.payload.text).not.toContain("budget remaining")
    expect(note.payload.text).not.toContain("spilled")
    const reading = (note.payload.meta as { reading: { contextUsage: { level: number } } }).reading
    expect(reading.contextUsage).toEqual({ level: 0, label: "<50%" })

    // 模型第一轮看到的最后一条就是它（约束 1：只追加在末尾）
    const first = lowering.requests[0]
    expect(first?.events.at(-1)?.id).toBe(note.id)
    // 约束 3：系统提示与工具表三轮逐字相同
    for (const req of lowering.requests) {
      expect(req.systemPrompt).toBe("你是计算器")
      expect(req.tools).toEqual(lowering.requests[0]?.tools)
    }
  })

  it("档位不变就不再追加：三轮只有一条说明，且每轮模型都仍能看到它（约束 2：不删不隐藏）", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering(THREE_TURNS)
    await drain(runLoop(config(lowering, log, { sockets: [perception()] })))
    const notes = notesOf(await all(log))
    expect(notes).toHaveLength(1)
    expect(lowering.requests).toHaveLength(3)
    for (const req of lowering.requests) {
      expect(notesOf(req.events).map((n) => n.id)).toEqual([notes[0]?.id])
    }
  })

  it("变档才追加新的一条，旧的留在原位：轮数档位设 [0, 1] 时三轮三条，每条都在当轮请求的末尾", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering(THREE_TURNS)
    // 数的是本轮之前已完成的模型轮：第 1 轮 0、第 2 轮 1、第 3 轮 2
    await drain(runLoop(config(lowering, log, { sockets: [perception({ turnTiers: [0, 1] })] })))
    const notes = notesOf(await all(log))
    expect(notes.map((n) => n.payload.text.match(/Unfolded history: (\S+) turns/)?.[1])).toEqual([
      "≤0",
      "1",
      ">1",
    ])
    lowering.requests.forEach((req, i) => {
      // 本轮看到 i+1 条说明，最新的一条殿后；更早的仍按原顺序留在历史里
      expect(notesOf(req.events).map((n) => n.id)).toEqual(notes.slice(0, i + 1).map((n) => n.id))
      expect(req.events.at(-1)?.id).toBe(notes[i]?.id)
    })
  })

  it("给了 limits 才报余量：按最紧的一维；余量跨档时追加新说明", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering(THREE_TURNS)
    // 剧本每轮用量 input 10 / output 5；上限 40：第 1 轮已花 0（≥50%）、第 2 轮 15（≥50%）、第 3 轮 30（剩 25% → 20%–50%）
    await drain(runLoop(config(lowering, log, { sockets: [perception({ limits: { totalTokens: 40 } })] })))
    const notes = notesOf(await all(log))
    expect(
      notes.map((n) => n.payload.text.match(/Run budget remaining: (\S+) \(tightest: (\w+)\)/)?.slice(1)),
    ).toEqual([
      ["≥50%", "totalTokens"],
      ["20%–50%", "totalTokens"],
    ])
  })
})

// ---- 纯函数层 ----

function fakeCtx(over: {
  events?: Event[]
  timeline?: Event[]
  budget?: Partial<TurnContext["budget"]>
  emitted?: EventDraft[]
}): TurnContext {
  const emitted = over.emitted ?? []
  return {
    session: { id: SESSION, turn: 1 },
    events: over.events ?? [],
    timeline: over.timeline ?? over.events ?? [],
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
      ...over.budget,
    },
    emit: (d) => emitted.push(d),
  }
}

let seq = 0
const ev = <T extends CoreEvent["type"]>(
  type: T,
  payload: CoreEventOf<T>["payload"],
  actor: Event["actor"],
) =>
  createCoreEvent(registry, {
    type,
    payload,
    actor,
    sessionId: SESSION,
    seq: ++seq,
    at: seq,
    id: `e${seq}`,
  } as Parameters<typeof createCoreEvent>[1]) as Event

const thresholds = {
  usage: [0.5, 0.7, 0.85],
  turns: [5, 15, 40],
  tokens: [10_000, 50_000, 200_000, 1_000_000],
  spills: [3, 10],
  remaining: [0.05, 0.2, 0.5],
}

describe("档位离散化", () => {
  it("连续量：边界值归上一档；两端开口", () => {
    const pct = (r: number) => `${Math.round(r * 100)}%`
    expect(rangeTier(0.49, [0.5, 0.7, 0.85], pct)).toEqual({ level: 0, label: "<50%" })
    expect(rangeTier(0.5, [0.5, 0.7, 0.85], pct)).toEqual({ level: 1, label: "50%–70%" })
    expect(rangeTier(0.85, [0.5, 0.7, 0.85], pct)).toEqual({ level: 3, label: "≥85%" })
    expect(rangeTier(1.2, [0.5, 0.7, 0.85], pct)).toEqual({ level: 3, label: "≥85%" })
  })

  it("计数量：≤b0 / b0+1–b1 / >bn；相邻边界只差 1 时标签是单个数", () => {
    expect(countTier(5, [5, 15, 40])).toEqual({ level: 0, label: "≤5" })
    expect(countTier(6, [5, 15, 40])).toEqual({ level: 1, label: "6–15" })
    expect(countTier(41, [5, 15, 40])).toEqual({ level: 3, label: ">40" })
    expect(countTier(2, [1, 2])).toEqual({ level: 1, label: "2" })
  })

  it("大数缩写", () => {
    expect([999, 10_000, 50_000, 1_500_000].map(compactNumber)).toEqual(["999", "10k", "50k", "1.5M"])
  })

  it("非升序边界在构造时拒绝", () => {
    expect(() => perception({ usageTiers: [0.7, 0.5] })).toThrow(RangeError)
    expect(() => perception({ turnTiers: [5, 5] })).toThrow(RangeError)
    expect(() => perception({ tokenTiers: [Number.NaN] })).toThrow(RangeError)
  })
})

describe("readPerception：读数来源与口径", () => {
  it("可见事件算轮数与外溢，完整日志算整理次数与累计 token（含缓存读写）", () => {
    const user = ev("core.user_message", { content: [{ type: "text", text: "hi" }] }, "user")
    const t1 = ev("core.model_text", { text: "a" }, "model")
    const call = ev("core.tool_call", { toolCallId: "c", name: "x", args: {} }, "model")
    const spilledResult = ev(
      "core.tool_result",
      { toolCallId: "c", name: "x", content: [], isError: false, spilled: { blobId: "b", summary: "s" } },
      "tool",
    )
    const usage = ev(
      "core.budget_usage",
      { tokens: { input: 1000, output: 500, cacheRead: 20_000, cacheWrite: 3_000 }, toolCalls: 1, wallMs: 1 },
      "system",
    )
    const t2 = ev("core.model_text", { text: "b" }, "model")
    const compaction = ev(
      "core.compaction",
      { coversSeq: [1, 2], summary: "…", decidedBy: "model", pinsKept: [] },
      "model",
    )
    const timeline = [user, t1, call, spilledResult, usage, t2, compaction]
    // 投影把 user / t1 折掉了，模型只看到摘要与其后的内容
    const visible = [compaction, call, spilledResult, t2]
    const r = readPerception(fakeCtx({ events: visible, timeline, budget: { used: 700 } }), thresholds)
    expect(r.contextUsage).toEqual({ level: 2, label: "70%–85%" })
    expect(r.autoFoldAt).toBe("85%")
    // call 与 t2 之间隔着 tool_result，所以是两轮
    expect(r.unfoldedTurns).toEqual({ level: 0, label: "≤5" })
    expect(r.compactions).toBe(1)
    expect(r.sessionTokens).toEqual({ level: 1, label: "10k–50k" })
    expect(r.spilledResults).toEqual({ level: 1, label: "1–3" })
    expect(r.budgetRemaining).toBeUndefined()
  })

  it("外溢为 0 单独占 level 0；余量取最紧一维，用尽时为 0 不为负", () => {
    const r = readPerception(fakeCtx({ budget: { tokensSpent: 90, turns: 3, toolCalls: 50 } }), thresholds, {
      totalTokens: 100,
      turns: 10,
      toolCalls: 40,
    })
    expect(r.spilledResults).toEqual({ level: 0, label: "0" })
    expect(r.budgetRemaining).toEqual({ level: 0, label: "<5%", tightest: "toolCalls" })
    expect(renderPerception(r)).toContain("Run budget remaining: <5% (tightest: toolCalls)")
  })
})

describe("perception Socket：判重与重注入", () => {
  const usage = (level: number) => ({ used: [100, 600, 800, 900][level] as number })

  it("视图里没有感知说明（首轮或被折叠掉）就注入；有且文字相同就不注入", () => {
    const socket = perception()
    const emitted: EventDraft[] = []
    const ctx = fakeCtx({ emitted, budget: usage(0) })
    socket.beforeModel?.(ctx)
    expect(emitted).toHaveLength(1)
    const draft = emitted[0] as { payload: { text: string } }

    // 把这条说明放进视图，再问一次：不追加
    const note = ev("core.system_note", { kind: "perception", text: draft.payload.text }, "system")
    const again: EventDraft[] = []
    socket.beforeModel?.(fakeCtx({ emitted: again, events: [note], budget: usage(0) }))
    expect(again).toHaveLength(0)

    // 折叠后视图里看不到它（只在完整日志里）：重新注入
    const folded: EventDraft[] = []
    socket.beforeModel?.(fakeCtx({ emitted: folded, events: [], timeline: [note], budget: usage(0) }))
    expect(folded).toHaveLength(1)
  })

  it("只看最后一条可见说明：用量涨档再落回时按最新可见的比", () => {
    const socket = perception()
    const texts: string[] = []
    const run = (visible: Event[], level: number) => {
      const emitted: EventDraft[] = []
      socket.beforeModel?.(fakeCtx({ emitted, events: visible, budget: usage(level) }))
      const d = emitted[0] as { payload: { text: string } } | undefined
      if (d) texts.push(d.payload.text)
      return d ? ev("core.system_note", { kind: "perception", text: d.payload.text }, "system") : undefined
    }
    const n0 = run([], 0) as Event
    const n1 = run([n0], 1) as Event
    expect(run([n0, n1], 1)).toBeUndefined() // 同档不追加
    const n2 = run([n0, n1], 0) as Event // 落回 <50%：最后可见的是 50–70%，要追加
    expect(texts).toHaveLength(3)
    expect(lastVisiblePerceptionNote([n0, n1, n2])?.id).toBe(n2.id)
    expect(lastVisiblePerceptionNote([])).toBeUndefined()
  })

  it("自定义 render 生效；判重按文字，render 忽略的字段变了也不追加", () => {
    const socket = perception({ render: (r) => `usage ${r.contextUsage.label}` })
    const emitted: EventDraft[] = []
    socket.beforeModel?.(fakeCtx({ emitted, budget: usage(1) }))
    const d = emitted[0] as { payload: { text: string; meta?: unknown } }
    expect(d.payload.text).toBe("usage 50%–70%")
    expect(d.payload.meta).toHaveProperty("reading")

    const note = ev("core.system_note", { kind: "perception", text: d.payload.text }, "system")
    const compaction = ev(
      "core.compaction",
      { coversSeq: [1, 1], summary: "x", decidedBy: "model", pinsKept: [] },
      "model",
    )
    const again: EventDraft[] = []
    // 整理次数变了，但自定义文案不含它 → 模型看到的没变 → 不追加
    socket.beforeModel?.(
      fakeCtx({ emitted: again, events: [note], timeline: [compaction, note], budget: usage(1) }),
    )
    expect(again).toHaveLength(0)
  })
})

describe("perception：用上一请求的真实用量校准上下文使用率（B8）", () => {
  it("contextOverheadOf：最后一条带 contextEstimate 的 budget_usage，真实上下文 = input + 缓存读写，减去估算；不为负", () => {
    const older = ev(
      "core.budget_usage",
      { tokens: { input: 5000, output: 10 }, toolCalls: 0, wallMs: 1, contextEstimate: 1000 },
      "system",
    )
    const noEstimate = ev(
      "core.budget_usage",
      { tokens: { input: 9000, output: 10 }, toolCalls: 0, wallMs: 1 },
      "system",
    )
    const latest = ev(
      "core.budget_usage",
      {
        tokens: { input: 1000, output: 10, cacheRead: 2000, cacheWrite: 500 },
        toolCalls: 0,
        wallMs: 1,
        contextEstimate: 1500,
      },
      "system",
    )
    expect(contextOverheadOf([older, noEstimate, latest])).toBe(2000)
    // 没有可对照的请求 → 0；真实比估算还小（估算偏高）→ 0 不为负
    expect(contextOverheadOf([noEstimate])).toBe(0)
    const over = ev(
      "core.budget_usage",
      { tokens: { input: 100, output: 1 }, toolCalls: 0, wallMs: 1, contextEstimate: 900 },
      "system",
    )
    expect(contextOverheadOf([over])).toBe(0)
  })

  it("读数用校准值：估算 21% 加上 2500 开销后跨到 50%–70% 档；calibrate:false 回到纯估算；余量的 contextTokens 维也用校准值", () => {
    const usage = ev(
      "core.budget_usage",
      {
        tokens: { input: 3000, output: 10, cacheRead: 1000 },
        toolCalls: 0,
        wallMs: 1,
        contextEstimate: 1500,
      },
      "system",
    )
    const ctx = fakeCtx({ timeline: [usage], budget: { used: 1700, contextLimit: 8000, targetTokens: 6800 } })
    const r = readPerception(ctx, thresholds)
    expect(r.contextOverhead).toBe(2500)
    expect(r.contextUsage).toEqual({ level: 1, label: "50%–70%" })
    const raw = readPerception(ctx, thresholds, undefined, { calibrate: false })
    expect(raw.contextOverhead).toBe(0)
    expect(raw.contextUsage).toEqual({ level: 0, label: "<50%" })
    // 4200 / 5000 已用 → 余 16%
    const withLimits = readPerception(ctx, thresholds, { contextTokens: 5000 })
    expect(withLimits.budgetRemaining).toEqual({ level: 1, label: "5%–20%", tightest: "contextTokens" })
  })

  it("循环里：第二轮读数吃到第一轮的真实用量，档位随之上跳并追加新说明", async () => {
    const log = new InMemoryEventLog()
    // 窗口 4000：估算不到 10%；第一轮真实 input 2500 远大于估算 → 第二轮校准后 ≥ 50%
    const lowering = new ScriptedLowering(
      [
        { drafts: [callTool("c1", "add", { a: 2, b: 3 })], outcome: { usage: { input: 2500, output: 5 } } },
        { drafts: [callTool("c2", "add", { a: 5, b: 4 })], outcome: { usage: { input: 2600, output: 5 } } },
        { drafts: [say("答案是 9")] },
      ],
      { capabilities: { contextWindow: 4000 } },
    )
    await drain(runLoop(config(lowering, log, { sockets: [perception()] })))
    const notes = notesOf(await all(log))
    expect(notes.length).toBeGreaterThanOrEqual(2)
    const levels = notes.map(
      (n) => (n.payload.meta as { reading: { contextUsage: { level: number } } }).reading.contextUsage.level,
    )
    expect(levels[0]).toBe(0)
    expect(levels[1]).toBeGreaterThanOrEqual(1)
    // 日志里的 budget_usage 带估算，回放时能重算同一读数
    const usages = (await all(log)).filter(
      (e) => e.type === "core.budget_usage",
    ) as CoreEventOf<"core.budget_usage">[]
    expect(usages.every((u) => typeof u.payload.contextEstimate === "number")).toBe(true)
  })
})
