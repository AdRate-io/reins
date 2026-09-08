/**
 * 门禁（P8"无 eval 不默认开"、PRD §7 门槛 2）：候选臂（模型自决）对照基线臂（纯阈值）的四条硬规则。
 *
 * 1. token 不多于基线的 100%（可配比例）
 * 2. 任务完成率不低于基线
 * 3. 关键信息召回不低于基线
 * 4. 压缩前后约束违规率不上升（候选臂自己整理前 vs 整理后）
 *
 * 只给结论与数字，怎么用（CI 红绿、默认开关）由调用方定。
 */
import type { ArmSummary, EvalReport } from "./types.js"

export interface GateOptions {
  /** 基线臂名，通常 "threshold" */
  reference: string
  /** 候选臂名，通常 "brain" */
  candidate: string
  /** 候选 token / 基线 token 的上限，缺省 1（不多于 100%） */
  tokenRatioMax?: number
}

export interface GateCheck {
  name: "tokens" | "completion" | "recall" | "governance"
  rule: string
  reference?: number
  candidate?: number
  pass: boolean
  /** 无法判定时的说明（如没有预埋事实） */
  note?: string
}

export interface GateResult {
  pass: boolean
  checks: GateCheck[]
  reference: ArmSummary
  candidate: ArmSummary
}

export function checkGate(report: EvalReport, opts: GateOptions): GateResult {
  const reference = report.summary[opts.reference]
  const candidate = report.summary[opts.candidate]
  if (!reference) throw new Error(`报告里没有基线臂 "${opts.reference}"`)
  if (!candidate) throw new Error(`报告里没有候选臂 "${opts.candidate}"`)
  const ratio = opts.tokenRatioMax ?? 1

  const checks: GateCheck[] = []

  checks.push({
    name: "tokens",
    rule: `候选总 token ≤ 基线 × ${ratio}`,
    reference: reference.tokens.total,
    candidate: candidate.tokens.total,
    pass: candidate.tokens.total <= reference.tokens.total * ratio,
  })

  checks.push({
    name: "completion",
    rule: "候选完成度 ≥ 基线",
    reference: reference.completion,
    candidate: candidate.completion,
    pass: candidate.completion >= reference.completion,
  })

  if (reference.recall === undefined && candidate.recall === undefined) {
    checks.push({ name: "recall", rule: "候选召回 ≥ 基线", pass: true, note: "没有预埋事实，视为通过" })
  } else {
    checks.push({
      name: "recall",
      rule: "候选召回 ≥ 基线",
      ...(reference.recall !== undefined ? { reference: reference.recall } : {}),
      ...(candidate.recall !== undefined ? { candidate: candidate.recall } : {}),
      pass: (candidate.recall ?? 0) >= (reference.recall ?? 0),
    })
  }

  checks.push({
    name: "governance",
    rule: "候选整理后违规率 ≤ 整理前",
    reference: candidate.violations.before,
    candidate: candidate.violations.after,
    pass: candidate.violations.after <= candidate.violations.before,
  })

  return { pass: checks.every((c) => c.pass), checks, reference, candidate }
}
