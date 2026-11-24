/**
 * 门禁（P8"无 eval 不默认开"、PRD §7 门槛 2）：候选臂（模型自决）对照基线臂（纯阈值）的四条硬规则。
 *
 * 1. token 不多于基线的 100%（可配比例）
 * 2. 任务完成率不低于基线
 * 3. 关键信息召回不低于基线
 * 4. 压缩前后约束违规率不上升（候选臂自己整理前 vs 整理后，只取整理后还有模型动作的格，见 ArmSummary.violations）
 *
 * 前提：两臂覆盖完全相同的 fixture × 重复（每格恰好一次），否则直接抛错——四条都是按格均值比，
 * 缺格（拆进程跑时某个进程崩了）或重复格会让两臂的均值不在同一组题上算，门禁结论没有意义。
 *
 * 只给结论与数字，怎么用（CI 红绿、默认开关）由调用方定。
 */
import type { ArmSummary, EvalOutcome, EvalReport } from "./types.js"

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
  if (!reference) throw new Error(`the report has no reference arm "${opts.reference}"`)
  if (!candidate) throw new Error(`the report has no candidate arm "${opts.candidate}"`)
  assertSameCells(report.outcomes, opts.reference, opts.candidate)
  const ratio = opts.tokenRatioMax ?? 1

  const checks: GateCheck[] = []

  checks.push({
    name: "tokens",
    rule: `candidate total tokens <= reference x ${ratio}`,
    reference: reference.tokens.total,
    candidate: candidate.tokens.total,
    pass: candidate.tokens.total <= reference.tokens.total * ratio,
  })

  checks.push({
    name: "completion",
    rule: "candidate completion >= reference",
    reference: reference.completion,
    candidate: candidate.completion,
    pass: candidate.completion >= reference.completion,
  })

  if (reference.recall === undefined && candidate.recall === undefined) {
    checks.push({
      name: "recall",
      rule: "candidate recall >= reference",
      pass: true,
      note: "no planted facts, counted as a pass",
    })
  } else {
    checks.push({
      name: "recall",
      rule: "candidate recall >= reference",
      ...(reference.recall !== undefined ? { reference: reference.recall } : {}),
      ...(candidate.recall !== undefined ? { candidate: candidate.recall } : {}),
      pass: (candidate.recall ?? 0) >= (reference.recall ?? 0),
    })
  }

  const governanceRule = "candidate violation rate after compaction <= before"
  if (candidate.violations.compactedRuns === 0) {
    checks.push({
      name: "governance",
      rule: governanceRule,
      pass: true,
      note: "no candidate run had model actions after a compaction, counted as a pass",
    })
  } else {
    checks.push({
      name: "governance",
      rule: governanceRule,
      reference: candidate.violations.before,
      candidate: candidate.violations.after,
      pass: candidate.violations.after <= candidate.violations.before,
    })
  }

  return { pass: checks.every((c) => c.pass), checks, reference, candidate }
}

/** 列名单时最多列几格，其余按"等 N 格"带过 */
const LIST_MAX = 10

const listCells = (keys: readonly string[]): string =>
  keys.length <= LIST_MAX
    ? keys.join(", ")
    : `${keys.slice(0, LIST_MAX).join(", ")} and ${keys.length - LIST_MAX} more`

/** 某臂的格键（`<fixtureId>#<repeat>`）；同一格出现两次即抛错 */
function cellKeysOf(outcomes: readonly EvalOutcome[], arm: string, role: string): Set<string> {
  const keys = new Set<string>()
  const duplicates: string[] = []
  for (const o of outcomes) {
    if (o.arm !== arm) continue
    const key = `${o.fixtureId}#${o.repeat}`
    if (keys.has(key)) duplicates.push(key)
    keys.add(key)
  }
  if (duplicates.length > 0)
    throw new Error(`the ${role} arm "${arm}" has duplicate cells: ${listCells(duplicates)}`)
  return keys
}

/** 两臂必须覆盖同一组 fixture × 重复：门禁按格均值比，缺格或多格都会让两边不在同一组题上算 */
function assertSameCells(outcomes: readonly EvalOutcome[], reference: string, candidate: string): void {
  const ref = cellKeysOf(outcomes, reference, "reference")
  const cand = cellKeysOf(outcomes, candidate, "candidate")
  const missingFromCandidate = [...ref].filter((k) => !cand.has(k))
  const missingFromReference = [...cand].filter((k) => !ref.has(k))
  if (missingFromCandidate.length === 0 && missingFromReference.length === 0) return
  const parts = [
    ...(missingFromCandidate.length > 0
      ? [`missing from candidate: ${listCells(missingFromCandidate)}`]
      : []),
    ...(missingFromReference.length > 0
      ? [`missing from reference: ${listCells(missingFromReference)}`]
      : []),
  ]
  throw new Error(
    `the reference and candidate arms must cover the same fixture x repeat cells; ${parts.join("; ")}`,
  )
}
