/**
 * onset-pause 汇总：按切点 × 臂列整理时机、兜底、召回、token 与回复长度。
 *
 *   node examples/eval/fixtures/onset-pause/summary.ts examples/eval/out/onset-pause
 *
 * 只读 run.ts 落盘的 cells/*.json（每格带 `timing`），不重跑模型。
 */
import { readdirSync, readFileSync } from "node:fs"
import type { TimingReport } from "./fixture.ts"

const dir = process.argv[2]
if (!dir) throw new Error("usage: node summary.ts <out dir>")

interface Cell {
  fixtureId: string
  arm: string
  repeat: number
  metrics: { status: string; recall?: number; tokens: { total: number; cacheRead: number }; turns: number }
  timing?: TimingReport
}

const cells: Cell[] = readdirSync(`${dir}/cells`)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(`${dir}/cells/${f}`, "utf8")) as Cell)
  .filter((c) => c.timing)

const groups = new Map<string, Cell[]>()
for (const c of cells) {
  const k = `${c.fixtureId}\t${c.arm}`
  groups.set(k, [...(groups.get(k) ?? []), c])
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
console.log("| 切点 | 臂 | 格 | 整理时机（每格） | 兜底 | 召回 | 轮 | 总 token | 缓存读占比 | 回复字数 |")
console.log("| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |")
for (const [k, cs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
  const [fixture, arm] = k.split("\t")
  cs.sort((a, b) => a.repeat - b.repeat)
  const timing = cs.map((c) => (c.timing?.model.length ? c.timing.model.join("+") : "—")).join(" / ")
  const tokens = avg(cs.map((c) => c.metrics.tokens.total))
  const cache = avg(cs.map((c) => (c.metrics.tokens.total ? c.metrics.tokens.cacheRead / c.metrics.tokens.total : 0)))
  const recall = cs.filter((c) => c.metrics.recall !== undefined).map((c) => c.metrics.recall as number)
  console.log(
    `| ${fixture?.replace("onset-pause-", "")} | ${arm} | ${cs.length} | ${timing} | ${cs.reduce((n, c) => n + (c.timing?.threshold ?? 0), 0)} | ${recall.length ? `${(avg(recall) * 100).toFixed(0)}%` : "—"} | ${avg(cs.map((c) => c.metrics.turns)).toFixed(1)} | ${(tokens / 1e6).toFixed(2)}M | ${(cache * 100).toFixed(0)}% | ${avg(cs.map((c) => c.timing?.finalChars ?? 0)).toFixed(0)} |`,
  )
}
