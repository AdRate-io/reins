import { describe, expect, it } from "vitest"
import type { Actor, Event } from "../events/base.js"
import type { CoreEventOf, CoreEventPayloads, CoreEventType } from "../events/core.js"
import { createCoreEvent } from "../events/create.js"
import { createCoreRegistry } from "../events/registry.js"
import { estimateTextTokens, roughTokenEstimate } from "./estimate.js"
import { DEFAULT_MODEL_INVISIBLE_TYPES, visibilityFilter } from "./filter.js"
import { foldCompactions } from "./fold.js"
import { reinjectPins } from "./pins.js"
import { defaultProjectionChain, project } from "./project.js"
import { budgetTruncate, splitTurns } from "./truncate.js"
import type { ProjectionContext } from "./types.js"

const registry = createCoreRegistry()
const SESSION = "s1"
const NOW = 1_800_000_000_000

/** 确定性 id：测试里用 seq 作 id，方便断言 */
const idOf = (seq: number) => `e${seq}`
const DEFAULT_ACTOR: Record<CoreEventType, Actor> = {
  "core.user_message": "user",
  "core.model_text": "model",
  "core.model_thinking": "model",
  "core.tool_call": "model",
  "core.tool_result": "tool",
  "core.system_note": "system",
  "core.approval_request": "system",
  "core.approval_decision": "host",
  "core.compaction": "model",
  "core.handoff": "model",
  "core.memory_op": "model",
  "core.budget_usage": "system",
  "core.run_paused": "system",
  "core.run_resumed": "host",
  "core.error": "system",
}

function ev<T extends CoreEventType>(seq: number, type: T, payload: CoreEventPayloads[T], actor?: Actor) {
  return createCoreEvent(registry, {
    type,
    payload,
    sessionId: SESSION,
    seq,
    actor: actor ?? DEFAULT_ACTOR[type],
    at: NOW - 1000 + seq,
    id: idOf(seq),
  })
}
const user = (seq: number, text: string) =>
  ev(seq, "core.user_message", { content: [{ type: "text", text }] })
const text = (seq: number, t: string) => ev(seq, "core.model_text", { text: t })
const thinking = (seq: number, t: string) => ev(seq, "core.model_thinking", { text: t })
const call = (seq: number, id: string, name = "read") =>
  ev(seq, "core.tool_call", { toolCallId: id, name, args: {} })
const result = (seq: number, id: string, t = "ok") =>
  ev(seq, "core.tool_result", {
    toolCallId: id,
    name: "read",
    content: [{ type: "text", text: t }],
    isError: false,
  })
const pin = (seq: number, t: string) => ev(seq, "core.system_note", { kind: "pin", text: t })
const note = (seq: number, t: string) => ev(seq, "core.system_note", { kind: "host", text: t })
const compaction = (
  seq: number,
  covers: [number, number],
  summary: string,
  pinsKept: string[] = [],
  decidedBy: "model" | "threshold" = "model",
) => ev(seq, "core.compaction", { coversSeq: covers, summary, decidedBy, pinsKept })

const seqs = (events: readonly Event[]) => events.map((e) => e.seq)

/** 直接调单个策略用的上下文；estimate 缺省每条 10 token，便于算预算 */
function ctxOf(timeline: readonly Event[], overrides: Partial<ProjectionContext> = {}): ProjectionContext {
  const last = timeline[timeline.length - 1]
  const base: ProjectionContext = {
    sessionId: SESSION,
    timeline,
    budget: { contextLimit: 1_000_000, reserveTokens: 0 },
    estimate: () => 10,
    registry,
    now: NOW,
    newId: () => "new-1",
    emitted: [],
    nextSeq: () => (last?.seq ?? 0) + 1,
  }
  return { ...base, ...overrides }
}

describe("roughTokenEstimate", () => {
  it("ASCII 约 4 字一 token，非 ASCII 一字一 token", () => {
    expect(estimateTextTokens("abcd")).toBe(1)
    expect(estimateTextTokens("abcde")).toBe(2)
    expect(estimateTextTokens("你好")).toBe(2)
    expect(estimateTextTokens("你好ab")).toBe(3)
  })

  it("各类事件都有估值，图片按常量，tool_call 计入参数", () => {
    expect(roughTokenEstimate(user(1, "hello world!"))).toBe(3 + 4)
    const img = ev(2, "core.user_message", { content: [{ type: "image", mime: "image/png", data: "AAAA" }] })
    expect(roughTokenEstimate(img)).toBe(1600 + 4)
    const small = call(3, "t1", "f")
    const big = ev(4, "core.tool_call", { toolCallId: "t2", name: "f", args: { text: "x".repeat(400) } })
    expect(roughTokenEstimate(big)).toBeGreaterThan(roughTokenEstimate(small) + 90)
    expect(
      roughTokenEstimate(
        ev(5, "core.budget_usage", { tokens: { input: 1, output: 2 }, toolCalls: 0, wallMs: 0 }),
      ),
    ).toBeGreaterThan(4)
  })
})

describe("visibilityFilter", () => {
  const timeline = [
    user(1, "hi"),
    ev(2, "core.approval_request", { toolCallId: "t", policyId: "p", summary: "s" }),
    ev(3, "core.approval_decision", { toolCallId: "t", approved: true, by: "u" }),
    ev(4, "core.run_paused", { reason: "approval" }),
    ev(5, "core.run_resumed", {}),
    ev(6, "core.budget_usage", { tokens: { input: 1, output: 1 }, toolCalls: 0, wallMs: 0 }),
    ev(7, "core.memory_op", { op: "view", path: "/memories/a" }),
    ev(8, "core.handoff", { toSessionId: "s2", summary: "x", reason: "r" }),
    ev(9, "core.error", { category: "provider", message: "m", retryable: true }),
    text(10, "hello"),
  ]

  it("默认剔除运维事件，保留对话事件", () => {
    const { events } = visibilityFilter().apply(timeline, ctxOf(timeline))
    expect(seqs(events)).toEqual([1, 10])
    expect(DEFAULT_MODEL_INVISIBLE_TYPES.size).toBe(8)
  })

  it("可覆盖不可见集合并追加宿主判定", () => {
    const { events } = visibilityFilter({
      invisibleTypes: ["core.error"],
      isVisible: (e) => e.seq !== 1,
    }).apply(timeline, ctxOf(timeline))
    expect(seqs(events)).toEqual([2, 3, 4, 5, 6, 7, 8, 10])
  })
})

describe("foldCompactions", () => {
  it("摘要替代其覆盖区间，原事件不再可见", () => {
    const timeline = [
      user(1, "a"),
      text(2, "b"),
      user(3, "c"),
      text(4, "d"),
      compaction(5, [1, 4], "S"),
      user(6, "e"),
    ]
    const { events } = foldCompactions().apply(timeline, ctxOf(timeline))
    expect(seqs(events)).toEqual([5, 6])
  })

  it("折叠旧的中间段时，摘要放在原段位置而不是自己的 seq 位置", () => {
    const timeline = [
      user(1, "a"),
      text(2, "b"),
      user(3, "c"),
      text(4, "d"),
      compaction(5, [1, 2], "S"),
      user(6, "e"),
    ]
    const { events } = foldCompactions().apply(timeline, ctxOf(timeline))
    expect(seqs(events)).toEqual([5, 3, 4, 6])
  })

  it("嵌套：新摘要盖住旧摘要，旧摘要不再可见但其覆盖范围仍生效", () => {
    const timeline = [
      user(1, "a"),
      text(2, "b"),
      compaction(3, [1, 2], "S1"),
      user(4, "c"),
      text(5, "d"),
      compaction(6, [1, 5], "S2"),
      user(7, "e"),
    ]
    const { events } = foldCompactions().apply(timeline, ctxOf(timeline))
    expect(seqs(events)).toEqual([6, 7])
  })

  it("旧摘要被盖住但其区间不在新摘要内时，旧区间仍然隐藏", () => {
    const timeline = [
      user(1, "a"),
      text(2, "b"),
      user(3, "c"),
      compaction(4, [1, 2], "S1"),
      user(5, "d"),
      compaction(6, [3, 5], "S2"),
      user(7, "e"),
    ]
    const { events } = foldCompactions().apply(timeline, ctxOf(timeline))
    // seq 4 被 S2 隐藏；但 1、2 仍因 S1 隐藏
    expect(seqs(events)).toEqual([6, 7])
  })

  it("pinsKept 引用的事件幸存；kind=pin 的 system_note 默认自动幸存", () => {
    const timeline = [
      user(1, "约束：不要删文件"),
      pin(2, "目标：迁移到 pg"),
      text(3, "ok"),
      compaction(4, [1, 3], "S", [idOf(1)]),
      user(5, "继续"),
    ]
    const { events } = foldCompactions().apply(timeline, ctxOf(timeline))
    // 幸存者留在原位（摘要之前），重排交给钉住策略
    expect(seqs(events)).toEqual([1, 2, 4, 5])
  })

  it("只有 kind=pin 自动幸存；kind=host 等普通注释照常被折叠", () => {
    const timeline = [
      note(1, "宿主提示"),
      pin(2, "约束"),
      text(3, "x"),
      compaction(4, [1, 3], "S"),
      user(5, "y"),
    ]
    const { events } = foldCompactions().apply(timeline, ctxOf(timeline))
    expect(seqs(events)).toEqual([2, 4, 5])
  })

  it("关闭自动幸存后，pin note 也要显式出现在 pinsKept 才留下", () => {
    const timeline = [pin(1, "p"), text(2, "x"), compaction(3, [1, 2], "S"), user(4, "y")]
    const { events } = foldCompactions({ autoKeepPinNotes: false }).apply(timeline, ctxOf(timeline))
    expect(seqs(events)).toEqual([3, 4])
  })

  it("被多次覆盖的事件必须被每一次 compaction 都保留才幸存", () => {
    const timeline = [
      user(1, "约束"),
      text(2, "x"),
      compaction(3, [1, 2], "S1", [idOf(1)]),
      user(4, "y"),
      compaction(5, [1, 4], "S2"),
      user(6, "z"),
    ]
    const { events } = foldCompactions().apply(timeline, ctxOf(timeline))
    expect(seqs(events)).toEqual([5, 6])
  })

  it("coversSeq 不能覆盖 compaction 自己或之后的事件", () => {
    const timeline = [user(1, "a"), compaction(2, [1, 99], "S"), user(3, "b")]
    const { events } = foldCompactions().apply(timeline, ctxOf(timeline))
    expect(seqs(events)).toEqual([2, 3])
  })
})

describe("reinjectPins", () => {
  it("幸存的 pin 挪到覆盖它的摘要之后", () => {
    const timeline = [
      user(1, "约束"),
      pin(2, "目标"),
      text(3, "ok"),
      compaction(4, [1, 3], "S", [idOf(1)]),
      user(5, "继续"),
    ]
    const folded = foldCompactions().apply(timeline, ctxOf(timeline)).events
    const { events } = reinjectPins().apply(folded, ctxOf(timeline))
    expect(seqs(events)).toEqual([4, 1, 2, 5])
  })

  it("被多个可见摘要覆盖时跟随最新的那个", () => {
    const timeline = [
      pin(1, "p"),
      text(2, "x"),
      compaction(3, [1, 2], "S1"),
      user(4, "y"),
      compaction(5, [4, 4], "S2"),
      user(6, "z"),
    ]
    // 两个摘要区间不重叠：p 只被 S1 覆盖
    const folded = foldCompactions().apply(timeline, ctxOf(timeline)).events
    expect(seqs(reinjectPins().apply(folded, ctxOf(timeline)).events)).toEqual([3, 1, 5, 6])
  })

  it("没有 compaction 时原样返回", () => {
    const timeline = [pin(1, "p"), user(2, "a")]
    expect(seqs(reinjectPins().apply(timeline, ctxOf(timeline)).events)).toEqual([1, 2])
  })
})

describe("splitTurns", () => {
  it("assistant 事件连成一轮，其余连成一轮", () => {
    const events = [
      user(1, "a"),
      thinking(2, "t"),
      text(3, "x"),
      call(4, "c1"),
      result(5, "c1"),
      user(6, "b"),
      text(7, "y"),
    ]
    expect(splitTurns(events).map(seqs)).toEqual([[1], [2, 3, 4], [5, 6], [7]])
  })
})

describe("budgetTruncate", () => {
  /** 一段典型对话：用户 → 思考+调用 → 结果 → 回答 → 用户 → ... */
  const timeline = [
    user(1, "第一问"),
    thinking(2, "想"),
    call(3, "c1"),
    result(4, "c1", "结果1"),
    text(5, "答一"),
    user(6, "第二问"),
    call(7, "c2"),
    result(8, "c2", "结果2"),
    text(9, "答二"),
    user(10, "第三问"),
  ]

  it("预算够时原样返回，不新造事件", () => {
    const step = budgetTruncate().apply(timeline, ctxOf(timeline))
    expect(seqs(step.events)).toEqual(seqs(timeline))
    expect(step.emitted).toBeUndefined()
  })

  it("超限时裁掉最旧的整轮，摘要在最前面并通过 emitted 交出", () => {
    // 10 条各 10 token = 100；目标 60。摘要估 10。裁掉 [1] [2,3,4? ...] 看切点
    const ctx = ctxOf(timeline, { budget: { contextLimit: 60, reserveTokens: 0 } })
    const step = budgetTruncate().apply(timeline, ctx)
    const first = step.events[0] as CoreEventOf<"core.compaction">
    expect(first.type).toBe("core.compaction")
    expect(first.payload.decidedBy).toBe("threshold")
    expect(first.seq).toBe(11)
    expect(first.id).toBe("new-1")
    expect(first.at).toBe(NOW)
    expect(first.actor).toBe("system")
    expect(step.emitted).toEqual([first])
    // 合法切点：保留部分第一轮不含 tool_result。切在 seq 6（user 轮）之前：剩 5 条 + 摘要 = 60 ✓
    expect(seqs(step.events)).toEqual([11, 6, 7, 8, 9, 10])
    expect(first.payload.coversSeq).toEqual([1, 5])
  })

  it("切点绝不让 tool_result 与其 tool_call 分离", () => {
    // 目标 80：只裁 [1] 省不出空间（摘要自己也占 10）；下一个切点在 result(4) 之前，不合法（会留下孤儿结果）；
    // 于是跳到 text(5) 之前，把 [1..4] 一起裁掉
    const ctx = ctxOf(timeline, { budget: { contextLimit: 80, reserveTokens: 0 } })
    const step = budgetTruncate().apply(timeline, ctx)
    expect(seqs(step.events)).toEqual([11, 5, 6, 7, 8, 9, 10])
    for (const e of step.events) {
      if (e.type === "core.tool_result") {
        const id = (e as CoreEventOf<"core.tool_result">).payload.toolCallId
        expect(
          step.events.some(
            (c) =>
              c.type === "core.tool_call" && (c as CoreEventOf<"core.tool_call">).payload.toolCallId === id,
          ),
        ).toBe(true)
      }
    }
  })

  it("裁不到预算以内时尽力裁到只剩最后一轮，并保持 events 可用", () => {
    const ctx = ctxOf(timeline, { budget: { contextLimit: 5, reserveTokens: 0 } })
    const step = budgetTruncate().apply(timeline, ctx)
    expect(seqs(step.events)).toEqual([11, 10])
    expect(step.emitted).toHaveLength(1)
  })

  it("pin 幸存并写入 pinsKept，紧随摘要之后", () => {
    const tl = [user(1, "a"), pin(2, "目标"), text(3, "x"), user(4, "b"), text(5, "y"), user(6, "c")]
    const ctx = ctxOf(tl, { budget: { contextLimit: 40, reserveTokens: 0 } })
    const step = budgetTruncate().apply(tl, ctx)
    const c = step.events[0] as CoreEventOf<"core.compaction">
    expect(c.payload.pinsKept).toEqual([idOf(2)])
    // 60 token 要压到 40：裁 [1,2] 省 20 但摘要+幸存 pin 又占 20，直到裁掉 [1..4] 才够
    expect(seqs(step.events)).toEqual([7, 2, 5, 6])
    expect(c.payload.coversSeq).toEqual([1, 4])
  })

  it("旧摘要并入新摘要原文，coversSeq 从旧摘要的起点算", () => {
    const tl = [compaction(5, [1, 4], "旧摘要内容"), user(6, "a"), text(7, "x"), user(8, "b")]
    const ctx = ctxOf(tl, { budget: { contextLimit: 20, reserveTokens: 0 } })
    const step = budgetTruncate().apply(tl, ctx)
    const c = step.events[0] as CoreEventOf<"core.compaction">
    expect(c.payload.coversSeq).toEqual([1, 7])
    expect(c.payload.summary).toContain("旧摘要内容")
    expect(c.payload.summary).toContain("seq 1-7")
    expect(seqs(step.events)).toEqual([9, 8])
  })

  it("seq 封闭：折叠把旧摘要挪到前面后，切点会跳过与它 seq 交错的事件", () => {
    // 模型在 seq 9 折叠了 1~4；折叠后可见顺序 [9, 5, 6, 7, 8, 10, 11]
    const tl = [
      user(1, "a"),
      text(2, "b"),
      user(3, "c"),
      text(4, "d"),
      user(5, "e"),
      text(6, "f"),
      user(7, "g"),
      text(8, "h"),
      compaction(9, [1, 4], "S"),
      user(10, "i"),
      text(11, "j"),
    ]
    const visible = foldCompactions().apply(tl, ctxOf(tl)).events
    expect(seqs(visible)).toEqual([9, 5, 6, 7, 8, 10, 11])
    // 目标 60：裁掉 [9] 就够（70-10+10=... 摘要 10 token，去掉 9 后剩 60+10 > 60，需再裁）
    // 任何把 9 裁掉却留下 5~8 的切点都不封闭，必须裁到 10 之前
    const step = budgetTruncate().apply(
      visible,
      ctxOf(tl, { budget: { contextLimit: 60, reserveTokens: 0 } }),
    )
    expect(seqs(step.events)).toEqual([12, 10, 11])
    expect((step.events[0] as CoreEventOf<"core.compaction">).payload.coversSeq).toEqual([1, 9])
  })

  it("可注入摘要函数", () => {
    const ctx = ctxOf(timeline, { budget: { contextLimit: 60, reserveTokens: 0 } })
    const step = budgetTruncate({ summarize: (removed) => `裁了 ${removed.length} 条` }).apply(timeline, ctx)
    expect((step.events[0] as CoreEventOf<"core.compaction">).payload.summary).toBe("裁了 5 条")
  })
})

describe("project（默认链端到端）", () => {
  const timeline = [
    user(1, "帮我把库迁到 pg，注意：不要动生产库"),
    pin(2, "约束：不要动生产库"),
    thinking(3, "先看 schema"),
    call(4, "c1", "read_schema"),
    result(5, "c1", "schema 内容 ".repeat(50)),
    ev(6, "core.budget_usage", { tokens: { input: 500, output: 50 }, toolCalls: 1, wallMs: 100 }),
    text(7, "看完了，开始写迁移"),
    user(8, "好"),
    call(9, "c2", "write_migration"),
    result(10, "c2", "written"),
    text(11, "写好了"),
    compaction(12, [1, 7], "用户要迁 pg；已读 schema", [idOf(1)]),
    user(13, "跑一下测试"),
  ]

  it("过滤 → 折叠 → 钉住 → 裁剪 全链输出确定，且 emitted 全在 events 里", () => {
    const run = () => project({ timeline, budget: { contextLimit: 100_000 }, now: NOW, newId: () => "fixed" })
    const a = run()
    const b = run()
    expect(a).toEqual(b)
    expect(seqs(a.events)).toEqual([12, 1, 2, 8, 9, 10, 11, 13])
    expect(a.emitted).toEqual([])
    expect(a.stats.overBudget).toBe(false)
    expect(a.stats.targetTokens).toBe(85_000)
    expect(a.stats.steps.map((s) => s.name)).toEqual([
      "visibility-filter",
      "fold-compactions",
      "reinject-pins",
      "budget-truncate",
    ])
    expect(a.stats.steps[0]).toEqual({ name: "visibility-filter", before: 13, after: 12 })
  })

  it("预算紧时兜底裁剪，产出待 append 的 threshold compaction 且 pin 仍幸存", () => {
    const r = project({
      timeline,
      budget: { contextLimit: 60, reserveTokens: 0 },
      estimate: () => 10,
      now: NOW,
      newId: () => "fixed",
    })
    expect(r.emitted).toHaveLength(1)
    const c = r.emitted[0] as CoreEventOf<"core.compaction">
    expect(c.seq).toBe(14)
    expect(c.payload.decidedBy).toBe("threshold")
    expect(c.payload.pinsKept).toEqual([idOf(1), idOf(2)])
    expect(c.payload.summary).toContain("用户要迁 pg；已读 schema")
    expect(r.events[0]).toBe(c)
    expect(seqs(r.events)).toEqual([14, 1, 2, 13])
    expect(r.stats.overBudget).toBe(false)
    expect(r.stats.estimatedTokens).toBe(40)
  })

  it("只剩最后一轮仍放不下时 overBudget 为真", () => {
    const r = project({
      timeline,
      budget: { contextLimit: 15, reserveTokens: 0 },
      estimate: () => 10,
      now: NOW,
    })
    expect(r.stats.overBudget).toBe(true)
    expect(seqs(r.events)).toEqual([14, 1, 2, 13])
  })

  it("感知插槽：提供 perception 策略时插在钉住与裁剪之间", () => {
    const chain = defaultProjectionChain({
      perception: { name: "perception", apply: (events) => ({ events: [...events] }) },
    })
    expect(chain.map((s) => s.name)).toEqual([
      "visibility-filter",
      "fold-compactions",
      "reinject-pins",
      "perception",
      "budget-truncate",
    ])
  })

  it("时间线乱序或空且无 sessionId 时拒绝", () => {
    expect(() => project({ timeline: [user(2, "a"), user(1, "b")], budget: { contextLimit: 100 } })).toThrow(
      RangeError,
    )
    expect(() => project({ timeline: [], budget: { contextLimit: 100 } })).toThrow(RangeError)
    expect(project({ timeline: [], budget: { contextLimit: 100 }, sessionId: SESSION }).events).toEqual([])
  })

  it("使用自定义 ext 注册表时能新造事件（registry 参数生效）", () => {
    const custom = createCoreRegistry([{ type: "ext.ping", version: 1 }])
    const r = project({
      timeline,
      budget: { contextLimit: 60, reserveTokens: 0 },
      estimate: () => 10,
      registry: custom,
      now: NOW,
    })
    expect(r.emitted[0]?.schemaVersion).toBe(1)
  })
})
