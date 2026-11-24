/**
 * README 配方即用例守门。
 *
 * 基线「README 配方即用例」：README 里给用户抄的配方代码，必须与 `*.recipe.test.ts` 里真跑过的那段逐字一致。
 * 以前只靠注释「与 README 逐字一致」自律，三处悄悄漂移了（全库审查 2026-11-25 #99），这里改成机械比对。
 *
 * 约定（两侧各一个标记）：
 * - 用例侧：配方本体夹在
 *     `// ---- 配方本体（与 README 逐字一致，改一处要同步另一处）----`
 *     `// ---- 配方本体结束 ----`
 *   之间。一个文件有多段时，开始行写成 `// ---- 配方本体 <id>（…）----`，id 只用小写字母、数字与连字符。
 * - README 侧：配方代码块的围栏（```ts）正上方一行写 HTML 注释 `<!-- recipe: <用例路径>#<id> -->`，
 *   路径相对仓库根；无 id 的段落写 `<!-- recipe: <用例路径> -->`。注释在 GitHub / npm 上不渲染。
 *
 * 范围：只核对带标记的代码块；README 里没标记的同类代码块（例如别处的副本）不在守门范围内。
 * 判据：配方本体（去掉首尾空行）必须作为**连续的整行**原样出现在被标记的代码块里——README 可以在前后多写
 * import 与调用示例（用例里这些由测试脚手架提供），但配方本体一个字符都不许改。另外：
 * 每个 recipe 用例至少一段本体、每段本体至少被一个 README 代码块引用、每个标记都指向存在的本体。
 *
 * 自包含：REPO_ROOT 按本文件位置 scripts/structure/ 反推。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

const BEGIN_RE = /^\/\/ ---- 配方本体(?: ([a-z0-9-]+))?（.*）----$/
const END_RE = /^\/\/ ---- 配方本体结束 ----$/
const MARKER_RE = /^<!-- recipe: (\S+?)(?:#([a-z0-9-]+))? -->$/
const FENCE_OPEN_RE = /^```[a-z]*$/

/** 一段配方本体；key 为 `<相对路径>#<id>`，无 id 时就是相对路径 */
interface Region {
  key: string
  lines: string[]
}

/** README 里一个被标记的代码块 */
interface MarkedBlock {
  readme: string
  /** 标记所在行号（1 起） */
  line: number
  key: string
  body: string[]
}

const keyOf = (file: string, id: string | undefined) => (id ? `${file}#${id}` : file)

/** 列出 packages 下所有 *.recipe.test.ts（相对仓库根，正斜杠） */
function recipeTestFiles(): string[] {
  const out: string[] = []
  const pkgRoot = path.join(REPO_ROOT, "packages")
  for (const pkg of readdirSync(pkgRoot)) {
    const src = path.join(pkgRoot, pkg, "src")
    if (!existsSync(src)) continue
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith(".recipe.test.ts"))
          out.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"))
      }
    }
    walk(src)
  }
  return out.sort()
}

/** 抽出一个用例文件里的全部配方本体；标记不配对直接抛错，错误信息指向行号 */
function regionsOf(file: string): Region[] {
  const lines = readFileSync(path.join(REPO_ROOT, file), "utf8").split("\n")
  const regions: Region[] = []
  let open: { key: string; start: number } | undefined
  lines.forEach((line, i) => {
    const begin = BEGIN_RE.exec(line)
    if (begin) {
      if (open) throw new Error(`${file}:${i + 1} 配方本体开始标记嵌套（上一段始于第 ${open.start + 1} 行）`)
      open = { key: keyOf(file, begin[1]), start: i }
      return
    }
    if (END_RE.test(line)) {
      if (!open) throw new Error(`${file}:${i + 1} 配方本体结束标记没有对应的开始标记`)
      regions.push({ key: open.key, lines: trimBlankEdges(lines.slice(open.start + 1, i)) })
      open = undefined
    }
  })
  if (open) throw new Error(`${file}:${open.start + 1} 配方本体没有结束标记 \`// ---- 配方本体结束 ----\``)
  return regions
}

function trimBlankEdges(lines: string[]): string[] {
  let a = 0
  let b = lines.length
  while (a < b && lines[a]?.trim() === "") a++
  while (b > a && lines[b - 1]?.trim() === "") b--
  return lines.slice(a, b)
}

/** 根 README 与 packages/<包>/README.md 里所有被标记的代码块 */
function markedBlocks(): MarkedBlock[] {
  const readmes = ["README.md"]
  for (const pkg of readdirSync(path.join(REPO_ROOT, "packages"))) {
    const rel = `packages/${pkg}/README.md`
    if (existsSync(path.join(REPO_ROOT, rel))) readmes.push(rel)
  }
  const out: MarkedBlock[] = []
  for (const readme of readmes) {
    const lines = readFileSync(path.join(REPO_ROOT, readme), "utf8").split("\n")
    lines.forEach((line, i) => {
      const m = MARKER_RE.exec(line)
      if (!m) return
      const where = `${readme}:${i + 1}`
      if (!FENCE_OPEN_RE.test(lines[i + 1] ?? "")) throw new Error(`${where} 配方标记的下一行必须是代码块围栏`)
      const close = lines.findIndex((l, j) => j > i + 1 && l === "```")
      if (close === -1) throw new Error(`${where} 配方标记后的代码块没有闭合`)
      out.push({ readme, line: i + 1, key: keyOf(m[1] as string, m[2]), body: lines.slice(i + 2, close) })
    })
  }
  return out
}

/** needle 是否作为连续整行出现在 haystack 里 */
function containsLines(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return false
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((l, j) => haystack[i + j] === l)) return true
  }
  return false
}

/** 不一致时给出第一处分歧，省得人肉 diff：按 README 块里与本体首行相同的位置对齐 */
function firstDivergence(block: string[], region: string[]): string {
  const start = block.indexOf(region[0] as string)
  if (start === -1) return `README 代码块里找不到配方本体的第一行：${JSON.stringify(region[0])}`
  for (let j = 0; j < region.length; j++) {
    if (block[start + j] !== region[j])
      return `配方本体第 ${j + 1} 行不一致\n  用例：${JSON.stringify(region[j])}\n  README：${JSON.stringify(block[start + j])}`
  }
  return "（未定位到分歧）"
}

/** 在用例里（而不是 describe 收集期）解析：标记不配对时报错信息能出现在测试结果里 */
function load() {
  const files = recipeTestFiles()
  const regions = new Map<string, Region>()
  for (const file of files) for (const r of regionsOf(file)) regions.set(r.key, r)
  return { files, regions, blocks: markedBlocks() }
}

describe("README 配方即用例", () => {
  it("每个 *.recipe.test.ts 至少有一段配方本体，且段落名不重复", () => {
    const { files } = load()
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const own = regionsOf(file)
      expect(own.length, `${file} 没有 \`// ---- 配方本体（…）----\` 段落`).toBeGreaterThan(0)
      const keys = own.map((r) => r.key)
      expect(new Set(keys).size, `${file} 段落名重复：${keys.join(", ")}`).toBe(keys.length)
    }
  })

  it("每段配方本体都被某个 README 代码块标记引用", () => {
    const { regions, blocks } = load()
    const referenced = new Set(blocks.map((b) => b.key))
    const orphans = [...regions.keys()].filter((k) => !referenced.has(k))
    expect(orphans, "这些配方本体没有 README 标记 `<!-- recipe: … -->` 指向").toEqual([])
  })

  it("每个 README 标记指向存在的配方本体，且本体逐字出现在被标记的代码块里", () => {
    const { regions, blocks } = load()
    const problems: string[] = []
    for (const b of blocks) {
      const region = regions.get(b.key)
      if (!region) {
        problems.push(`${b.readme}:${b.line} 指向不存在的配方本体 ${b.key}`)
        continue
      }
      if (!containsLines(b.body, region.lines))
        problems.push(`${b.readme}:${b.line} 与 ${b.key} 不一致：${firstDivergence(b.body, region.lines)}`)
    }
    expect(problems, problems.join("\n\n")).toEqual([])
  })
})
