/**
 * 把报告排成 Markdown 表：一臂一行，Boss 看这张表就够。要机器读请直接用 EvalReport（JSON）。
 */
import type { GateResult } from "./gate.js"
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
  lines.push(`# eval 报告`)
  lines.push("")
  lines.push(
    `模型 \`${report.model.provider}/${report.model.id}\`，${fixtures} 个 fixture × ${arms.length} 臂，共 ${report.outcomes.length} 次运行，耗时 ${secs(report.finishedAt - report.startedAt)}。`,
  )
  lines.push("")
  lines.push(
    "| 臂 | 跑完 | 完成度 | 总 token | 缓存命中 | 召回 | 违规率 前→后 | 整理 模型/阈值/连续 | 轮 | 工具 | 重复调用 | 墙钟 |",
  )
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
  for (const a of arms) {
    lines.push(
      `| ${a.arm} | ${pct(a.finishedRate)} | ${pct(a.completion)} | ${num(a.tokens.total)} | ${pct(a.cacheHitRate, 1)} | ${pct(a.recall)} | ${pct(a.violations.before, 1)} → ${pct(a.violations.after, 1)} | ${a.compactions.model.toFixed(1)} / ${a.compactions.threshold.toFixed(1)} / ${a.compactions.maxConsecutive.toFixed(1)} | ${a.turns.toFixed(1)} | ${a.toolCalls.toFixed(1)} | ${a.repeatedToolCalls.toFixed(1)} | ${secs(a.wallMs)} |`,
    )
  }
  lines.push("")
  lines.push("均值按 fixture × 重复取；整理三列是每次运行的次数均值。")

  if (opts.gate) {
    lines.push("")
    lines.push(
      `## 门禁：${opts.gate.pass ? "通过 ✅" : "未通过 ❌"}（候选 \`${opts.gate.candidate.arm}\` 对照 \`${opts.gate.reference.arm}\`）`,
    )
    lines.push("")
    lines.push("| 规则 | 基线 | 候选 | 结果 |")
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
    lines.push("## 明细")
    lines.push("")
    lines.push(
      "| fixture | 臂 | # | 状态 | 完成度 | 总 token | 缓存命中 | 召回 | 违规 前/后 | 整理 模型/阈值/连续 | 轮 | 工具 | 墙钟 |",
    )
    lines.push("| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for (const o of report.outcomes) lines.push(detailRow(o))
  }
  return `${lines.join("\n")}\n`
}

function detailRow(o: EvalOutcome): string {
  const m = o.metrics
  return `| ${o.fixtureId} | ${o.arm} | ${o.repeat} | ${m.status} | ${pct(m.completed)} | ${num(m.tokens.total)} | ${pct(m.cacheHitRate, 1)} | ${pct(m.recall)} | ${m.violations.before.violations}/${m.violations.before.actions} → ${m.violations.after.violations}/${m.violations.after.actions} | ${m.compactions.model} / ${m.compactions.threshold} / ${m.compactions.maxConsecutive} | ${m.turns} | ${m.toolCalls} | ${secs(m.wallMs)} |`
}
