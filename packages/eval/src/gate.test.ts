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
