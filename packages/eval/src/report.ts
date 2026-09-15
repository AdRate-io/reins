/**
 * 把报告排成 Markdown 表：一臂一行，Boss 看这张表就够。要机器读请直接用 EvalReport（JSON）。
 */

import type { GateResult } from "./gate.js"
import { billableTokens } from "./metrics.js"
import type { EvalOutcome, EvalReport } from "./types.js"

export interface RenderOptions {
  /** 附上门禁结论 */
  gate?: GateResult
  /** 每个 fixture × 臂 × 重复各一行的明细 */
  detail?: boolean
}

const pct = (v: number | undefined, digits = 0): string =>
  v === undefined ? "—" : `${(v * 100).toFixed(digits)}%`
const num = (v: number): string => Math.round(v).toLocaleString("en-US")
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

export function renderReport(report: EvalReport, opts: RenderOptions = {}): string {
  const arms = Object.values(report.summary)
  const lines: string[] = []
  const fixtures = new Set(report.outcomes.map((o) => o.fixtureId)).size
  lines.push(`# eval report`)
  lines.push("")
  lines.push(
    `Model \`${report.model.provider}/${report.model.id}\`, ${fixtures} fixture(s) x ${arms.length} arm(s), ${report.outcomes.length} run(s), took ${secs(report.finishedAt - report.startedAt)}.`,
  )
  lines.push("")
  lines.push(
    "| arm | finished | completion | total tokens | billable equiv. | cache hits | recall | violation rate before->after | compactions model/threshold/consecutive | turns | tool calls | repeated calls | wall clock |",
  )
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
  for (const a of arms) {
    lines.push(
      `| ${a.arm} | ${pct(a.finishedRate)} | ${pct(a.completion)} | ${num(a.tokens.total)} | ${num(billableTokens(a.tokens))} | ${pct(a.cacheHitRate, 1)} | ${pct(a.recall)} | ${pct(a.violations.before, 1)} → ${pct(a.violations.after, 1)} | ${a.compactions.model.toFixed(1)} / ${a.compactions.threshold.toFixed(1)} / ${a.compactions.maxConsecutive.toFixed(1)} | ${a.turns.toFixed(1)} | ${a.toolCalls.toFixed(1)} | ${a.repeatedToolCalls.toFixed(1)} | ${secs(a.wallMs)} |`,
    )
  }
  lines.push("")
  lines.push(
    "Averages are taken over fixture x repeat; the three compaction columns are mean counts per run. Total tokens count cache reads at 1x (what the model read each turn); the billable equivalent discounts cache reads to 0.1x (what the bill looks like).",
  )

  if (opts.gate) {
    lines.push("")
    lines.push(
      `## Gate: ${opts.gate.pass ? "passed ✅" : "failed ❌"} (candidate \`${opts.gate.candidate.arm}\` against \`${opts.gate.reference.arm}\`)`,
    )
    lines.push("")
    lines.push("| rule | reference | candidate | result |")
    lines.push("| --- | ---: | ---: | --- |")
    for (const c of opts.gate.checks) {
      const fmt = (v: number | undefined) =>
        v === undefined ? "—" : c.name === "tokens" ? num(v) : pct(v, 1)
      lines.push(
        `| ${c.rule} | ${fmt(c.reference)} | ${fmt(c.candidate)} | ${c.pass ? "✅" : "❌"}${c.note ? ` ${c.note}` : ""} |`,
      )
    }
  }

  if (opts.detail) {
    lines.push("")
    lines.push("## Details")
    lines.push("")
    lines.push(
      "| fixture | arm | # | status | completion | total tokens | billable equiv. | cache hits | recall | violations before/after | compactions model/threshold/consecutive | turns | tool calls | wall clock |",
    )
    lines.push(
      "| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    )
    for (const o of report.outcomes) lines.push(detailRow(o))
  }
  return `${lines.join("\n")}\n`
}

function detailRow(o: EvalOutcome): string {
  const m = o.metrics
  return `| ${o.fixtureId} | ${o.arm} | ${o.repeat} | ${m.status} | ${pct(m.completed)} | ${num(m.tokens.total)} | ${num(billableTokens(m.tokens))} | ${pct(m.cacheHitRate, 1)} | ${pct(m.recall)} | ${m.violations.before.violations}/${m.violations.before.actions} → ${m.violations.after.violations}/${m.violations.after.actions} | ${m.compactions.model} / ${m.compactions.threshold} / ${m.compactions.maxConsecutive} | ${m.turns} | ${m.toolCalls} | ${secs(m.wallMs)} |`
}
