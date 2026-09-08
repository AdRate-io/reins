/**
 * 汇总 out/ 下所有运行：每个 provider × 配置 × 运行 的平均命中率、缓存读 / 写合计，以及
 * "紧跟感知说明的请求"与"其余请求"分开的平均命中率 —— 直接回答"注入是否拉低命中"。
 *   node spikes/b1-perception-cache/summarize.mjs
 */
import { readdir, readFile } from "node:fs/promises"

const dir = new URL("./out/", import.meta.url)
const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort()
const pct = (x) => `${(x * 100).toFixed(1)}%`
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN)

for (const f of files) {
  const data = JSON.parse(await readFile(new URL(f, dir), "utf8"))
  console.log(`\n${data.provider} ${data.model} — ${data.label}`)
  console.log("  配置      说明  均命中(2+)  紧跟说明的请求  其余请求   cacheRead  cacheWrite  input")
  for (const v of data.results) {
    const later = v.rows.slice(1)
    const withNote = later.filter((r) => r.note).map((r) => r.ratio)
    const without = later.filter((r) => !r.note).map((r) => r.ratio)
    const sum = (k) => v.rows.reduce((a, r) => a + r[k], 0)
    console.log(
      `  ${v.name.padEnd(9)} ${String(v.notes).padStart(3)}    ${pct(mean(later.map((r) => r.ratio))).padStart(7)}` +
        `     ${(withNote.length ? pct(mean(withNote)) : "—").padStart(9)}      ${(without.length ? pct(mean(without)) : "—").padStart(7)}` +
        `   ${String(sum("cacheRead")).padStart(7)}   ${String(sum("cacheWrite")).padStart(7)}   ${String(sum("input")).padStart(5)}`,
    )
  }
}
