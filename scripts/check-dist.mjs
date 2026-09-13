/**
 * 构建产物自检（E4）：`pnpm build` 之后跑，发布前必过。
 *
 * 1. 每个包 package.json `exports` 里的每个 JS 入口都能被 `import()`，且约定的关键导出存在——源码与 vitest 全绿不代表 dist 能跑
 *    （tsup 剥 `node:` 前缀、条件导出写错、d.ts 内联依赖，都只在 dist 上炸，见踩坑记录 store-sqlite）。
 * 2. 硬约束（技术方案 §1）：`@reins/core` / `@reins/brain` 及各包主入口零 `node:*`；`node:*` 只允许出现在 `/node` 子路径。
 * 3. `/node` 子路径必须保留 `node:` 协议前缀（tsup 8 缺省 removeNodeProtocol 会把 `node:sqlite` 剥成裸 `sqlite`，运行时找不到模块）。
 * 4. 运行时版本常量 `REINS_VERSION` 与 `@reins/core` 的 package.json 版本一致（MCP 握手、排错都拿它报版本；0.1 发前审查抓到过 0.0.0）。
 *
 *   node scripts/check-dist.mjs
 */
import { readdir, readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const root = new URL("../", import.meta.url)
const packagesDir = new URL("packages/", root)

/** 每个入口至少要有的导出名（抽样，不求全） */
const EXPECTED = {
  "@reins/core": ["runLoop", "createCoreRegistry", "project", "readTimeline", "subagentPause", "markUntrusted"],
  "@reins/core/testing": ["ScriptedLowering", "callTool", "say"],
  "@reins/brain": ["perception", "compact", "pins", "spill", "handoff", "memory", "approval", "budget", "skills", "inlineSkills"],
  "@reins/brain/node": ["fsSkillSource"],
  "@reins/lowering-pi": ["anthropic", "openai", "PiAiLowering", "LOSS_MATRIX"],
  "@reins/server": ["createAgentHandler", "rawEncoder"],
  "@reins/server/node": ["nodeListener"],
  "@reins/store-sqlite": ["sqliteStores"],
  "@reins/store-sqlite/node": ["openSqlite"],
  "@reins/store-pg": ["pgStores"],
  "@reins/eval": ["runEval", "checkGate", "renderReport"],
  "@reins/ui-agui": ["aguiEncoding", "createAguiEncoder", "mapEvent"],
  "@reins/adapter-tanstack-ai": ["reinsMiddleware", "reinsApprovalInterrupt"],
  "@reins/tools-mcp": ["mcpTools", "httpTransport"],
  "@reins/tools-mcp/node": ["stdioTransport"],
  reins: ["createAgent", "asTool", "runLoop"],
}

/** 允许出现 `node:` 的入口：只有 /node 子路径 */
const NODE_ALLOWED = new Set([
  "@reins/server/node",
  "@reins/store-sqlite/node",
  "@reins/tools-mcp/node",
  "@reins/brain/node",
])

const failures = []
const rows = []

for (const dir of (await readdir(packagesDir, { withFileTypes: true })).filter((d) => d.isDirectory())) {
  const pkgUrl = new URL(`${dir.name}/`, packagesDir)
  const pkg = JSON.parse(await readFile(new URL("package.json", pkgUrl), "utf8"))
  for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
    const file = typeof target === "string" ? target : target.import ?? target.default
    if (!file || !file.endsWith(".js")) continue // demo/index.html 之类不是模块
    const entry = sub === "." ? pkg.name : `${pkg.name}/${sub.slice(2)}`
    const fileUrl = new URL(file, pkgUrl)
    const row = { entry, file, exports: "?", node: "-", ok: true }
    rows.push(row)
    try {
      const mod = await import(pathToFileURL(fileUrl.pathname).href)
      const missing = (EXPECTED[entry] ?? []).filter((name) => !(name in mod))
      row.exports = `${Object.keys(mod).length}${missing.length ? ` 缺 ${missing.join(",")}` : ""}`
      if (missing.length) throw new Error(`缺少导出 ${missing.join(", ")}`)
      if (!EXPECTED[entry]) throw new Error("check-dist.mjs 的 EXPECTED 表没登记这个入口")
      if (entry === "@reins/core" && mod.REINS_VERSION !== pkg.version)
        throw new Error(`REINS_VERSION 是 ${mod.REINS_VERSION}，package.json 是 ${pkg.version}，改 packages/core/src/index.ts`)
    } catch (err) {
      row.ok = false
      failures.push(`${entry}: ${err.message}`)
    }
    // node:* 出现与协议前缀：扫整个 dist 目录里被这个入口引用的文件太重，按入口文件本身与其同目录 chunk 粗查
    const text = await readFile(fileUrl, "utf8")
    const nodeImports = [...text.matchAll(/from\s+["'](node:[^"']+)["']|import\(["'](node:[^"']+)["']\)/g)].map((m) => m[1] ?? m[2])
    const bareNodeBuiltins = [...text.matchAll(/from\s+["'](sqlite|fs|path|child_process|process|http|crypto|url|os|stream|events)["']/g)].map((m) => m[1])
    row.node = nodeImports.length ? nodeImports.join(",") : bareNodeBuiltins.length ? `裸 ${bareNodeBuiltins.join(",")}` : "-"
    if (nodeImports.length && !NODE_ALLOWED.has(entry)) {
      row.ok = false
      failures.push(`${entry}: 主入口不许依赖 node 内置模块，却 import 了 ${nodeImports.join(", ")}`)
    }
    if (bareNodeBuiltins.length) {
      row.ok = false
      failures.push(`${entry}: node 内置模块丢了 node: 前缀（${bareNodeBuiltins.join(", ")}），检查 tsup 的 removeNodeProtocol`)
    }
    if (NODE_ALLOWED.has(entry) && !nodeImports.length && !bareNodeBuiltins.length) {
      // /node 入口按定义要用 node:*；一个都没有多半是打包把它 inline 进 chunk 了，提示一下但不算失败
      row.node = "（无直接 node: import）"
    }
  }
}

const w = (s, n) => String(s).padEnd(n)
console.log(`${w("入口", 30)} ${w("文件", 26)} ${w("导出数", 12)} node:*`)
for (const r of rows) console.log(`${r.ok ? "✓" : "✗"} ${w(r.entry, 28)} ${w(r.file, 26)} ${w(r.exports, 12)} ${r.node}`)
if (failures.length) {
  console.error(`\n${failures.length} 处不通过：\n- ${failures.join("\n- ")}`)
  process.exit(1)
}
console.log(`\n${rows.length} 个入口全部可 import，node:* 只在 /node 子路径，REINS_VERSION 与包版本一致。`)
