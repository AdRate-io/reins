/**
 * 把 `recordings/raw/` 下的真实录像（已 gitignore，永不进仓库）脱敏成可公开的 `recordings/*.jsonl`，并重生成回放页面：
 *
 *   node examples/adrate/scrub.ts [--replace-text <路径>]
 *
 * 口径 = DECISIONS 2026-09-09 E2：广告主 id、计划 id、请求 id、Command / 凭证 id、人名 / 团队名 / 广告主名 / 授权账号名
 * 换等长别名；测试广告主的计划名（Boss 造的数据）、时间戳、用量、模型思考保留。S1 录像核过：出现的计划名全是测试广告主的。
 *
 * 别名表按录像顺序建：先在 patrol-disable 上按 E2 的规则与顺序建表（与 `examples/eval/fixtures/adrate-patrol/build.ts`
 * 完全一致，公开录像与 fixture 里同一个值同一个别名），其余录像新出现的值接着编号。同一个值在所有录像里处处一起变。
 *
 * `--replace-text` 把整张表写成 git filter-repo 的 replace-text 文件（**含原值**，只放 /tmp、用完即删）：真实 id 曾散落在
 * README / 示例源码 / 单测 / 文档里，2026-09-14 用它把全部历史一次换干净。
 *
 * 自查：每份录像里按规则找到的值必须都在表里、脱敏后原值一个不剩、剩下的 19 位 / 16 位 id 只能是别名形态、无邮箱残留。
 * 报告只打印计数，不打印原文。
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { aliasTable, jsonValuesAt, matchStrings, parseEventsJsonl, type Replacement, scrubEvents, toEventsJsonl, unspillRecording } from "@reinsjs/eval"
import type { Event } from "@reinsjs/agent"

const here = (p: string) => new URL(p, import.meta.url)
const RAW = (name: string) => here(`./recordings/raw/${name}.jsonl`)
const OUT = (name: string) => here(`./recordings/${name}.jsonl`)
/** 顺序即别名编号顺序：patrol 必须第一个（E2 表），其余按字母序 */
const RECORDINGS = ["patrol-disable", "s1-skills-claude", "s1-skills-deepseek"] as const
const pad = (n: number, width: number) => String(n).padStart(width, "0")

interface Rule {
  key: string
  pick: (events: readonly Event[]) => string[]
  alias: (i: number) => string
}
const RULES: Rule[] = [
  { key: "advertiser", pick: (e) => matchStrings(e, /\b7\d{18}\b/), alias: (i) => `7000000000000000${pad(i, 3)}` },
  { key: "campaign", pick: (e) => matchStrings(e, /\b18\d{14}\b/), alias: (i) => `18000000000${pad(i, 5)}` },
  { key: "request", pick: (e) => matchStrings(e, /\blocal_[0-9a-f]{32}\b/), alias: (i) => `local_${pad(i, 32)}` },
  { key: "command", pick: (e) => jsonValuesAt(e, ["commandId", "credentialId"]), alias: (i) => `00000000-0000-4000-8000-${pad(i, 12)}` },
  { key: "name", pick: (e) => jsonValuesAt(e, ["nickname", "teamName", "advertiserName", "displayName"]), alias: (i) => `name_${pad(i, 2)}` },
]
/** 录像里照样打码（与 fixture 同别名），但不进历史替换表：产品团队名不是隐私，eval 单测还拿它当样例 */
const REPLACE_TEXT_SKIP = new Set(["AdRate 团队"])

function main(): void {
  const replaceTextOut = process.argv.includes("--replace-text") ? process.argv[process.argv.indexOf("--replace-text") + 1] : undefined
  const table = new Map<string, string>()
  const counts = new Map<string, number>(RULES.map((r) => [r.key, 0]))
  const raws = new Map<string, Event[]>()

  // 1. 建表：patrol 按 E2（在去外溢后的事件上取值，顺序与 build.ts 一致），其余录像接着编号
  for (const name of RECORDINGS) {
    if (!existsSync(RAW(name))) throw new Error(`缺原始录像 ${RAW(name).pathname}（raw/ 只在本地，从备份取回）`)
    const raw = parseEventsJsonl(readFileSync(RAW(name), "utf8"))
    raws.set(name, raw)
    const source = name === "patrol-disable" ? unspillRecording(raw).events : raw
    for (const rule of RULES) {
      const fresh = rule.pick(source).filter((v) => !table.has(v))
      const base = counts.get(rule.key) ?? 0
      for (const [from, to] of aliasTable(fresh, (i) => rule.alias(base + i))) table.set(from, to)
      counts.set(rule.key, base + fresh.length)
    }
  }
  const replacements: Replacement[] = [...table]
  console.log("别名表：", Object.fromEntries(counts), "合计", table.size)

  // 2. 逐份脱敏 + 自查
  for (const name of RECORDINGS) {
    const raw = raws.get(name) as Event[]
    for (const rule of RULES) {
      const missing = rule.pick(raw).filter((v) => !table.has(v))
      if (missing.length > 0) throw new Error(`${name}：${rule.key} 有 ${missing.length} 个值不在表里（raw 与去外溢版取值不一致？）`)
    }
    const { events, hits } = scrubEvents(raw, replacements)
    const after = JSON.stringify(events)
    for (const [from] of replacements) if (after.includes(from)) throw new Error(`${name}：脱敏后仍残留原值`)
    for (const id of new Set(after.match(/\b7\d{18}\b/g))) if (!/^7000000000000000\d{3}$/.test(id)) throw new Error(`${name}：残留非别名形态的广告主 id`)
    for (const id of new Set(after.match(/\b18\d{14}\b/g))) if (!/^18000000000\d{5}$/.test(id)) throw new Error(`${name}：残留非别名形态的计划 id`)
    const emails = (after.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []).filter((s) => !s.startsWith("reins-"))
    if (emails.length > 0) throw new Error(`${name}：疑似邮箱残留 ${emails.length} 处`)
    writeFileSync(OUT(name), toEventsJsonl(events))
    console.log(`${name}：${events.length} 条事件，命中 ${hits.filter((h) => h > 0).length} 条规则 → ${OUT(name).pathname}`)

    // 3. 回放页面：与 run.ts 同一条命令，从脱敏后的 JSONL 重生成（不要从 raw 的 html 改）
    const html = OUT(name).pathname.replace(/\.jsonl$/, ".html")
    execFileSync("node", [here("../minimal/replay.ts").pathname, OUT(name).pathname, "--agent", here("./agent.ts").pathname, "--html", html], { stdio: ["ignore", "ignore", "inherit"] })
    console.log(`  回放页面 → ${html}`)
  }

  // 4. filter-repo 替换表（含原值，调用方负责放在仓库外并用完删除）
  if (replaceTextOut) {
    const rows = replacements.filter(([from]) => !REPLACE_TEXT_SKIP.has(from))
    for (const [from] of rows) if (from.includes("==>") || from.includes("\n")) throw new Error("有值含 filter-repo 分隔符")
    writeFileSync(replaceTextOut, `${rows.map(([from, to]) => `${from}==>${to}`).join("\n")}\n`)
    console.log(`replace-text 表 ${rows.length} 行 → ${replaceTextOut}（含原值，用完即删）`)
  }
}

main()
