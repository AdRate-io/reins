/**
 * OnSet 摄影会话 → 本地 fixture 数据（只落 `data/`，已 gitignore，不进仓库）。
 *
 * 为什么不进仓库：reins 仓库公开，这是 Boss 的 OnSet 内部项目（人设、剧本、生成素材与花费），脱敏也只是去掉链接，内容本身仍是内部资料。
 * 仓库里只有 build / fixture 代码，换台机器要先从 OnSet 库重新生成。
 *
 *   sqlite3 -readonly <OnSet>/data/onset.db ".backup /tmp/onset-copy.db"
 *   （在 OnSet 仓库里先跑 dump-onset.mts 得 world-spec.json，见该文件头）
 *   node examples/eval/fixtures/onset-pause/build.ts /tmp/onset-copy.db /tmp/world-spec.json
 *
 * 做的事：按会话 id 取出全部事件（seq 升序）→ 供应商临时素材链接换别名（同值同别名）→ 自查无链接 / IP / 密钥残留 → 写出。
 * 图片（base64）原样保留：上下文占用里有它们一份，去掉就到不了 70% 那一档，这组 fixture 就没意义了。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

/** 第三轮试拍里摄影角色的会话：11 次 run、683 条事件，上下文从 <50% 涨到 ≥85%，一次都没整理 */
export const CINEMATOGRAPHER_SESSION = "01a18abb-3a7d-7780-809f-406a2a67b31a"

const [dbPath, specPath] = process.argv.slice(2)
if (!dbPath || !specPath) throw new Error("usage: node build.ts <onset db copy> <world-spec.json>")

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db
  .prepare("SELECT data FROM reins_events WHERE session_id = ? ORDER BY seq")
  .all(CINEMATOGRAPHER_SESSION) as { data: string }[]
db.close()
if (rows.length === 0) throw new Error(`session ${CINEMATOGRAPHER_SESSION} not found in ${dbPath}`)

// 供应商临时素材链接：生成结果的下载地址，换成等义的别名
const aliases = new Map<string, string>()
const VENDOR_URL = /https:\/\/static\.aireiter\.com\/[A-Za-z0-9/_.-]+/g
const scrub = (line: string) =>
  line.replace(VENDOR_URL, (url) => {
    let alias = aliases.get(url)
    if (!alias) {
      const ext = url.match(/\.(\w+)$/)?.[1] ?? "bin"
      alias = `https://media.example/onset/${aliases.size + 1}.${ext}`
      aliases.set(url, alias)
    }
    return alias
  })
const lines = rows.map((r) => scrub(r.data))

// 自查：去掉 base64 后不应再有真实链接、IP、密钥形状的串（example.com / media.example 是占位）
const text = lines.join("\n").replace(/"data":"[A-Za-z0-9+/=]{200,}"/g, '"data":""')
const leaks = [
  ...[...text.matchAll(/https?:\/\/[^\s"\\）)]+/g)]
    .map((m) => m[0])
    .filter((u) => !/^https:\/\/(example\.com|media\.example)\//.test(u)),
  ...[...text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)].map((m) => m[0]),
  ...[...text.matchAll(/\b(?:sk|cfut)[-_][A-Za-z0-9_-]{8,}/g)].map((m) => m[0]),
]
if (leaks.length) throw new Error(`scrub incomplete: ${[...new Set(leaks)].slice(0, 5).join(", ")}`)

const out = new URL("./data/", import.meta.url)
mkdirSync(out, { recursive: true })
writeFileSync(new URL("session.jsonl", out), `${lines.join("\n")}\n`)
writeFileSync(new URL("world.json", out), readFileSync(specPath))
console.log(`${lines.length} events, ${aliases.size} vendor links aliased → ${out.pathname}`)
