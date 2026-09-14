/**
 * 把 run.ts 落盘的各格结果汇总成一份报告：
 *
 *   node examples/eval/report.ts <out 目录> [--reference threshold] [--candidate brain] [--token-ratio 1] [--suite adrate-patrol|tool-discovery]
 *
 * 读 `cells/*.json`（每格一份，可能来自多次 / 多进程运行，同名后写覆盖先写），用 @reinsjs/eval 的 summarize 求臂均值、
 * checkGate 跑 PRD §7 门槛 2 四条、renderReport 出 Markdown；写 `report.md` 与 `report.json`。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import {
  checkGate,
  type EvalOutcome,
  type EvalReport,
  finalTextOf,
  gradeExpect,
  mean,
  parseEventsJsonl,
  probeAnswerOf,
  renderReport,
  summarize,
} from "@reinsjs/eval"
import { adratePatrolFixtures } from "./fixtures/adrate-patrol/fixture.ts"
import { toolDiscoveryFixtures } from "./fixtures/tool-discovery/fixture.ts"

const argv = process.argv.slice(2)
const dir = argv.find((a) => !a.startsWith("--"))
if (!dir) throw new Error("用法：node examples/eval/report.ts <out 目录>")
const flag = (name: string, dflt: string) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : dflt
}

/** --rescore：评分器改了口径时，用落盘的时间线把完成度重算一遍，不必重跑模型；改动写回 cell 文件（保留原值 completedBefore） */
const rescore = argv.includes("--rescore")
const suiteName = flag("--suite", "adrate-patrol")
const suite = rescore ? (suiteName === "tool-discovery" ? toolDiscoveryFixtures() : adratePatrolFixtures()) : undefined

const files = readdirSync(`${dir}/cells`).filter((f) => f.endsWith(".json")).sort()
const outcomes: EvalOutcome[] = []
let model = { provider: "?", id: "?" }
let contextWindow: number | undefined
for (const f of files) {
  const path = `${dir}/cells/${f}`
  const cell = JSON.parse(readFileSync(path, "utf8")) as EvalOutcome & {
    model: { provider: string; id: string }
    contextWindow?: number
    completedBefore?: number
  }
  model = cell.model
  contextWindow = cell.contextWindow
  const jsonl = path.replace(/\.json$/, ".jsonl")
  if (suite && existsSync(jsonl)) {
    const fixture = suite.fixtures.find((x) => x.id === cell.fixtureId)
    if (!fixture) throw new Error(`没有 fixture ${cell.fixtureId}`)
    const timeline = parseEventsJsonl(readFileSync(jsonl, "utf8"))
    const fresh = timeline.slice(fixture.task.seed?.length ?? 0)
    const draft = { ...cell, timelines: [timeline], timeline, fresh, finalText: finalTextOf(fresh) }
    const completed = Math.min(1, Math.max(0, Number(await fixture.completion(draft)) || 0))
    let changed = false
    if (completed !== cell.metrics.completed) {
      console.error(`重算 ${f}: 完成度 ${cell.metrics.completed.toFixed(2)} → ${completed.toFixed(2)}`)
      cell.completedBefore ??= cell.metrics.completed
      cell.metrics.completed = completed
      changed = true
    }
    // 探针：按落盘的探针事件重判（回答口径改成"正文为空退回 thinking"后，旧格不必重跑）
    const probesPath = path.replace(/\.json$/, ".probes.jsonl")
    if (existsSync(probesPath) && fixture.facts?.length) {
      const probeEvents = parseEventsJsonl(readFileSync(probesPath, "utf8"))
      const bySession = new Map<string, typeof probeEvents>()
      for (const e of probeEvents) bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e])
      for (const fact of fixture.facts) {
        const session = [...bySession.values()].find((evs) =>
          evs.some((e) => e.type === "core.user_message" && JSON.stringify(e.payload).includes(fact.question)),
        )
        const cur = cell.facts.find((x) => x.id === fact.id)
        if (!session || !cur || fact.expect === undefined) continue
        const { answer, answerFrom } = probeAnswerOf(session)
        const score = gradeExpect(fact.expect, answer)
        if (score !== cur.score || cur.answerFrom === undefined) {
          if (score !== cur.score) console.error(`重判 ${f} ${fact.id}: ${cur.score} → ${score}（${answerFrom}）`)
          Object.assign(cur, { answer, answerFrom, score })
          changed = true
        }
      }
      const recall = mean(cell.facts.map((x) => x.score))
      if (recall !== cell.metrics.recall) {
        cell.metrics.recall = recall
        changed = true
      }
    }
    if (changed) writeFileSync(path, JSON.stringify(cell, null, 2))
  }
  // 明细里用不到时间线；summarize / checkGate / renderReport 只看 metrics 与 facts
  outcomes.push({ ...cell, timelines: [], timeline: [], fresh: [] })
}
if (outcomes.length === 0) throw new Error(`${dir}/cells 下没有结果`)

const finishedAt = Date.now()
const report: EvalReport = {
  model,
  // 各格只存了墙钟，报告的"耗时"按墙钟之和给（并行跑时比真实时长长）
  startedAt: finishedAt - outcomes.reduce((a, o) => a + o.metrics.wallMs, 0),
  finishedAt,
  outcomes,
  summary: summarize(outcomes),
}
const reference = flag("--reference", "threshold")
const candidate = flag("--candidate", "brain")
const gate =
  report.summary[reference] && report.summary[candidate]
    ? checkGate(report, { reference, candidate, tokenRatioMax: Number(flag("--token-ratio", "1")) })
    : undefined

const byFixture = new Map<string, EvalOutcome[]>()
for (const o of outcomes) byFixture.set(o.fixtureId, [...(byFixture.get(o.fixtureId) ?? []), o])
const perFixture = [...byFixture.entries()]
  .map(([fid, list]) => {
    const s = summarize(list)
    const rows = Object.values(s).map(
      (a) =>
        `| ${a.arm} | ${a.runs} | ${(a.finishedRate * 100).toFixed(0)}% | ${(a.completion * 100).toFixed(0)}% | ${a.recall === undefined ? "—" : `${(a.recall * 100).toFixed(0)}%`} | ${Math.round(a.tokens.total).toLocaleString("en-US")} | ${a.cacheHitRate === undefined ? "—" : `${(a.cacheHitRate * 100).toFixed(0)}%`} | ${a.turns.toFixed(1)} | ${a.toolCalls.toFixed(1)} | ${a.repeatedToolCalls.toFixed(1)} | ${a.compactions.model.toFixed(1)}/${a.compactions.threshold.toFixed(1)} | ${(a.violations.before * 100).toFixed(1)}% → ${(a.violations.after * 100).toFixed(1)}% | ${(a.wallMs / 1000).toFixed(0)}s |`,
    )
    return `### ${fid}\n\n| 臂 | 格 | 跑完 | 完成度 | 召回 | token | cache | 轮 | 工具 | 重复 | 整理(模型/阈值) | 违规 前→后 | 墙钟 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}`
  })
  .join("\n\n")

const md = `# eval 对照报告 —— ${model.provider}/${model.id}（窗口 ${contextWindow ?? "缺省"}）

${renderReport(report, gate ? { gate, detail: true } : { detail: true })}

## 按 fixture

${perFixture}
`
writeFileSync(`${dir}/report.md`, md)
writeFileSync(`${dir}/report.json`, JSON.stringify({ model, contextWindow, summary: report.summary, gate, outcomes }, null, 2))
console.log(md)
