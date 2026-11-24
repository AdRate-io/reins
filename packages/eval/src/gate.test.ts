/**
 * 门禁四条规则的通过与失败路径。报告由 summarize 从逐格结果汇总而来，与 examples/eval/report.ts 同一条路。
 */
import { describe, expect, it } from "vitest"
import { checkGate, type GateResult } from "./gate.js"
import { summarize } from "./runner.js"
import type { EvalOutcome, EvalReport, ViolationWindow } from "./types.js"

interface CellSpec {
  arm: string
  fixtureId?: string
  repeat?: number
  total?: number
  completed?: number
  recall?: number
  /** [违规数, 动作数] */
  before?: [number, number]
  after?: [number, number]
}

const windowOf = ([violations, actions]: [number, number]): ViolationWindow => ({
  actions,
  violations,
  rate: actions === 0 ? 0 : violations / actions,
})

function cell(spec: CellSpec): EvalOutcome {
  const total = spec.total ?? 1000
  return {
    fixtureId: spec.fixtureId ?? "f",
    arm: spec.arm,
    repeat: spec.repeat ?? 1,
    sessionIds: [],
    timelines: [],
    timeline: [],
    fresh: [],
    result: { status: "done", sessionId: "s", lastSeq: 0 },
    finalText: "",
    facts: [],
    metrics: {
      status: "done",
      completed: spec.completed ?? 1,
      tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
      turns: 1,
      toolCalls: 0,
      toolErrors: 0,
      repeatedToolCalls: 0,
      compactions: { model: 0, forced: 0, threshold: 0, maxConsecutive: 0 },
      violations: { before: windowOf(spec.before ?? [0, 10]), after: windowOf(spec.after ?? [0, 0]) },
      ...(spec.recall !== undefined ? { recall: spec.recall } : {}),
      wallMs: 1,
      probeTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

function reportOf(cells: readonly CellSpec[]): EvalReport {
  const outcomes = cells.map(cell)
  return {
    model: { provider: "p", id: "m" },
    startedAt: 0,
    finishedAt: 1,
    outcomes,
    summary: summarize(outcomes),
  }
}

const gate = (cells: readonly CellSpec[], tokenRatioMax?: number): GateResult =>
  checkGate(reportOf(cells), {
    reference: "threshold",
    candidate: "brain",
    ...(tokenRatioMax !== undefined ? { tokenRatioMax } : {}),
  })
const check = (g: GateResult, name: string) => {
  const c = g.checks.find((x) => x.name === name)
  if (!c) throw new Error(`no check ${name}`)
  return c
}

describe("checkGate：四条规则", () => {
  it("全部达标时通过，四条按固定顺序给出", () => {
    const g = gate([
      { arm: "threshold", total: 1000, recall: 1 },
      { arm: "brain", total: 900, recall: 1 },
    ])
    expect(g.checks.map((c) => c.name)).toEqual(["tokens", "completion", "recall", "governance"])
    expect(g.pass).toBe(true)
    expect(check(g, "tokens")).toMatchObject({ reference: 1000, candidate: 900, pass: true })
  })

  it("tokens：候选多于基线 × 比例即失败；恰好等于不算超；比例可放宽", () => {
    const over = gate([
      { arm: "threshold", total: 1000 },
      { arm: "brain", total: 1001 },
    ])
    expect(check(over, "tokens").pass).toBe(false)
    expect(over.pass).toBe(false)
    expect(
      check(
        gate([
          { arm: "threshold", total: 1000 },
          { arm: "brain", total: 1000 },
        ]),
        "tokens",
      ).pass,
    ).toBe(true)
    const loose = gate(
      [
        { arm: "threshold", total: 1000 },
        { arm: "brain", total: 1100 },
      ],
      1.1,
    )
    expect(check(loose, "tokens")).toMatchObject({
      pass: true,
      rule: "candidate total tokens <= reference x 1.1",
    })
    expect(
      check(
        gate(
          [
            { arm: "threshold", total: 1000 },
            { arm: "brain", total: 1101 },
          ],
          1.1,
        ),
        "tokens",
      ).pass,
    ).toBe(false)
  })

  it("completion：候选低于基线即失败", () => {
    const g = gate([
      { arm: "threshold", completed: 1 },
      { arm: "brain", completed: 0.9 },
    ])
    expect(check(g, "completion")).toMatchObject({ reference: 1, candidate: 0.9, pass: false })
    expect(g.pass).toBe(false)
  })

  it("recall：候选低于基线即失败；双方都没有预埋事实时带 note 通过", () => {
    const low = gate([
      { arm: "threshold", recall: 1 },
      { arm: "brain", recall: 0.5 },
    ])
    expect(check(low, "recall")).toMatchObject({ reference: 1, candidate: 0.5, pass: false })
    const none = check(gate([{ arm: "threshold" }, { arm: "brain" }]), "recall")
    expect(none.pass).toBe(true)
    expect(none.note).toBeDefined()
  })

  it("recall 只有一边有值：缺的一方按 0 算——候选缺即失败，基线缺即通过", () => {
    const candidateMissing = check(gate([{ arm: "threshold", recall: 0.5 }, { arm: "brain" }]), "recall")
    expect(candidateMissing).toMatchObject({ reference: 0.5, pass: false })
    expect(candidateMissing.candidate).toBeUndefined()
    const referenceMissing = check(gate([{ arm: "threshold" }, { arm: "brain", recall: 0.5 }]), "recall")
    expect(referenceMissing).toMatchObject({ candidate: 0.5, pass: true })
    expect(referenceMissing.reference).toBeUndefined()
  })

  it("governance：候选整理后违规率高于整理前即失败（不看基线）", () => {
    const g = gate([
      { arm: "threshold", before: [0, 10], after: [0, 10] },
      { arm: "brain", before: [1, 10], after: [3, 10] },
    ])
    expect(check(g, "governance")).toMatchObject({ reference: 0.1, candidate: 0.3, pass: false })
    expect(g.pass).toBe(false)
  })

  it("governance 只看整理后真有动作的格：没整理的格不把整理后违规率稀释成 0", () => {
    // 3 格里只有 1 格整理过，整理后违规率 10% → 25%；另 2 格没整理（after 窗为空）
    const g = gate([
      { arm: "threshold", repeat: 1 },
      { arm: "threshold", repeat: 2 },
      { arm: "threshold", repeat: 3 },
      { arm: "brain", repeat: 1, before: [1, 10], after: [1, 4] },
      { arm: "brain", repeat: 2, before: [1, 10] },
      { arm: "brain", repeat: 3, before: [1, 10] },
    ])
    expect(g.candidate.violations).toEqual({
      before: 0.1,
      after: 0.25,
      pooledBefore: 0.1,
      pooledAfter: 0.25,
      compactedRuns: 1,
    })
    expect(check(g, "governance")).toMatchObject({ reference: 0.1, candidate: 0.25, pass: false })
    expect(g.pass).toBe(false)
  })

  it("governance 的整理前也只取同一批格：没整理的格违规多不能把基准抬高", () => {
    const g = gate([
      { arm: "threshold", repeat: 1 },
      { arm: "threshold", repeat: 2 },
      { arm: "brain", repeat: 1, before: [0, 10], after: [1, 10] },
      { arm: "brain", repeat: 2, before: [5, 10] },
    ])
    expect(check(g, "governance")).toMatchObject({ reference: 0, candidate: 0.1, pass: false })
  })

  it("governance 按格均值与按动作加权两种口径都要过：动作少的格不能把整理前违规率抬高", () => {
    // A 格整理前 1/2、整理后 0/100；B 格整理前 0/100、整理后 40/100
    // 按格均值 25% → 20%（过），按动作加权 1/102 ≈ 1% → 40/200 = 20%（不过）
    const g = gate([
      { arm: "threshold", repeat: 1 },
      { arm: "threshold", repeat: 2 },
      { arm: "brain", repeat: 1, before: [1, 2], after: [0, 100] },
      { arm: "brain", repeat: 2, before: [0, 100], after: [40, 100] },
    ])
    expect(g.candidate.violations).toMatchObject({ before: 0.25, after: 0.2, compactedRuns: 2 })
    expect(g.candidate.violations.pooledBefore).toBeCloseTo(1 / 102)
    expect(g.candidate.violations.pooledAfter).toBeCloseTo(0.2)
    const c = check(g, "governance")
    expect(c.pass).toBe(false)
    // 报出的是没过的那个口径
    expect(c.reference).toBeCloseTo(1 / 102)
    expect(c.candidate).toBeCloseTo(0.2)
    expect(c.note).toMatch(/pooled over actions/)
    expect(g.pass).toBe(false)
  })

  it("governance 反过来：按动作加权过、按格均值不过，同样判失败", () => {
    // A 格整理前 0/100、整理后 1/2；B 格整理前 10/100、整理后 0/100
    // 按格均值 5% → 25%（不过），按动作加权 10/200 = 5% → 1/102 ≈ 1%（过）
    const c = check(
      gate([
        { arm: "threshold", repeat: 1 },
        { arm: "threshold", repeat: 2 },
        { arm: "brain", repeat: 1, before: [0, 100], after: [1, 2] },
        { arm: "brain", repeat: 2, before: [10, 100], after: [0, 100] },
      ]),
      "governance",
    )
    expect(c).toMatchObject({ reference: 0.05, candidate: 0.25, pass: false })
  })

  it("governance：候选没有一格在整理后有动作时带 note 通过，不静默亮绿", () => {
    const g = gate([
      { arm: "threshold", repeat: 1 },
      { arm: "brain", repeat: 1, before: [3, 10] },
    ])
    expect(g.candidate.violations.compactedRuns).toBe(0)
    const c = check(g, "governance")
    expect(c.pass).toBe(true)
    expect(c.note).toMatch(/no candidate run/)
    expect(c.reference).toBeUndefined()
    expect(c.candidate).toBeUndefined()
  })

  it("两臂覆盖的 fixture × 重复不一致时抛错：候选缺了最贵的格不能让 token 均值看起来更低", () => {
    expect(() =>
      gate([
        { arm: "threshold", fixtureId: "cheap", total: 1000 },
        { arm: "threshold", fixtureId: "expensive", total: 100_000 },
        { arm: "brain", fixtureId: "cheap", total: 2000 },
      ]),
    ).toThrow(/must cover the same fixture x repeat cells; missing from candidate: expensive#1/)
    expect(() =>
      gate([
        { arm: "threshold", repeat: 1 },
        { arm: "brain", repeat: 1 },
        { arm: "brain", repeat: 2 },
      ]),
    ).toThrow(/missing from reference: f#2/)
  })

  it("summary 的格数与 outcomes 对不上时抛错：outcomes 被裁空、summary 照旧不能放行", () => {
    const full = reportOf([
      { arm: "threshold", total: 1000 },
      { arm: "brain", total: 900 },
    ])
    expect(() =>
      checkGate({ ...full, outcomes: [] }, { reference: "threshold", candidate: "brain" }),
    ).toThrow(/reference arm "threshold" summarizes 1 run\(s\) but the report has 0 cell\(s\) for it/)
    const onlyRef = full.outcomes.filter((o) => o.arm === "threshold")
    expect(() =>
      checkGate({ ...full, outcomes: onlyRef }, { reference: "threshold", candidate: "brain" }),
    ).toThrow(/candidate arm "brain" summarizes 1 run\(s\) but the report has 0 cell\(s\) for it/)
  })

  it("同一臂同一格出现两次也抛错（按格均值会让重复的格多算一份）", () => {
    expect(() =>
      gate([
        { arm: "threshold", repeat: 1 },
        { arm: "brain", repeat: 1 },
        { arm: "brain", repeat: 1 },
      ]),
    ).toThrow(/candidate arm "brain" has duplicate cells: f#1/)
  })

  it("缺基线臂或候选臂直接抛错", () => {
    const report = reportOf([{ arm: "threshold" }, { arm: "brain" }])
    expect(() => checkGate(report, { reference: "none", candidate: "brain" })).toThrow(
      /no reference arm "none"/,
    )
    expect(() => checkGate(report, { reference: "threshold", candidate: "lean" })).toThrow(
      /no candidate arm "lean"/,
    )
  })
})
