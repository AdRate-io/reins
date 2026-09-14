/**
 * D1 核实：逐轮变动请求工具集对 prompt cache 的影响（技术方案 §9.10）。
 *
 * 同一个 200 件工具表（examples/eval/fixtures/tool-discovery 的目录）、同一个会话里连续做 6 个任务（每个任务一次 run），两臂各跑一遍：
 *   eager  200 件全在每次请求里（不装模块）
 *   lazy   装 lazyTools：请求里只有已取回的 + tool_find，取回之后的第一个请求工具表变了
 * 记每次请求的 budget_usage.tokens（input / cacheRead / cacheWrite / output）与请求里的工具件数，
 * 命中占比 = cacheRead / (input + cacheRead + cacheWrite)。看两件事：
 *   1. lazy 臂取回后的那次请求缓存是否整段重写（Anthropic 文档：工具表变动使 tools / system / messages 全部失效）
 *   2. 六个任务算总账，lazy 的未命中 token（input + cacheWrite）与总 token 是否仍低于 eager
 *
 * 运行：先 pnpm build，然后 node spikes/d1-lazy-tools-cache/measure.ts <relay|deepseek> [eager|lazy|all]
 * 密钥从仓库根 `模型API测试信息.md` 读（与 examples/eval/run.ts 同一套字段）；REINS_MODEL 可换模型。
 * 结果打印表格并写 out/<provider>-<model>-<arm>.json（已 gitignore）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import {
  TASKS,
  TOOL_DISCOVERY_SYSTEM_PROMPT,
  toolDiscoveryFixtures,
} from "../../examples/eval/fixtures/tool-discovery/fixture.ts"
import { lazyTools } from "../../packages/brain/dist/index.js"
import { InMemoryEventLog, runLoop } from "../../packages/core/dist/index.js"
import { anthropic } from "../../packages/lowering-pi/dist/index.js"

type Provider = "relay" | "deepseek"
const provider = (process.argv[2] ?? "deepseek") as Provider
const which = process.argv[3] ?? "all"
if (provider !== "relay" && provider !== "deepseek")
  throw new Error("用法：measure.ts <relay|deepseek> [eager|lazy|all]")

// ---- 模型（与 examples/eval/run.ts 同源）----
const INFO = new URL("../../模型API测试信息.md", import.meta.url)
const info = readFileSync(INFO, "utf8")
function readKey(section: Provider): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  if (section === "relay") {
    const block = info.slice(info.lastIndexOf("Claude中转"))
    const key = block.match(/key[：:]\s*(sk-[A-Za-z0-9_-]+)/)?.[1]
    if (!key) throw new Error("没在 模型API测试信息.md 的 Claude中转 段找到 key")
    return key
  }
  const keys = [...info.matchAll(/密钥[^`]*`(sk-[^`]+)`/g)].map((m) => m[1] as string)
  const key = keys[1]
  if (!key) throw new Error("没在 模型API测试信息.md 里找到 deepseek 的密钥")
  return key
}
function relayBase(): string {
  const block = info.slice(info.lastIndexOf("Claude中转"))
  const base = block.match(/baseurl[：:]\s*(\S+)/)?.[1]?.replace(/\/+$/, "")
  if (!base) throw new Error("没在 模型API测试信息.md 的 Claude中转 段找到 baseurl")
  return base
}
const modelId = process.env.REINS_MODEL ?? (provider === "relay" ? "claude-sonnet-5" : "deepseek-v4-flash")
const bound = anthropic(modelId, {
  apiKey: readKey(provider),
  baseUrl: provider === "relay" ? relayBase() : "https://api.deepseek.com/anthropic",
  requestOptions: { thinkingEnabled: true, thinkingBudgetTokens: 2048 },
  midConversationSystem: true,
})

// ---- 记每次请求的工具件数：包一层 lowering ----
const toolCounts: number[] = []
const lowering = {
  capabilities: (m: Parameters<typeof bound.lowering.capabilities>[0]) => bound.lowering.capabilities(m),
  toRequest(input: Parameters<typeof bound.lowering.toRequest>[0]) {
    toolCounts.push(input.tools?.length ?? 0)
    return bound.lowering.toRequest(input)
  },
  stream: (r: Parameters<typeof bound.lowering.stream>[0], c?: Parameters<typeof bound.lowering.stream>[1]) =>
    bound.lowering.stream(r, c),
} as typeof bound.lowering

interface Row {
  arm: string
  task: string
  req: number
  tools: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  hit: number
}

const suite = toolDiscoveryFixtures()
const tools = suite.catalog.tools

async function runArm(arm: "eager" | "lazy"): Promise<{ rows: Row[]; calls: string[] }> {
  const log = new InMemoryEventLog()
  const sessionId = `d1-${arm}-${Date.now()}`
  const rows: Row[] = []
  const calls: string[] = []
  let req = 0
  toolCounts.length = 0
  for (const task of TASKS) {
    const gen = runLoop({
      sessionId,
      log,
      lowering,
      model: bound.model,
      tools,
      sockets: arm === "lazy" ? [lazyTools()] : [],
      systemPrompt: TOOL_DISCOVERY_SYSTEM_PROMPT,
      input: task.input,
      maxTurns: 10,
    })
    while (true) {
      const step = await gen.next()
      if (step.done) {
        if (step.value.status !== "done") console.log(`  ⚠ ${task.id} 以 ${step.value.status} 结束`)
        break
      }
      const e = step.value as { type: string; payload: Record<string, unknown> }
      if (e.type === "core.tool_call") {
        const p = e.payload as { name: string; args: unknown }
        calls.push(`${task.id}:${p.name}${p.name === "tool_find" ? JSON.stringify(p.args) : ""}`)
      }
      if (e.type === "core.budget_usage") {
        const t = e.payload.tokens as {
          input: number
          output: number
          cacheRead?: number
          cacheWrite?: number
        }
        const cacheRead = t.cacheRead ?? 0
        const cacheWrite = t.cacheWrite ?? 0
        const denom = t.input + cacheRead + cacheWrite
        const row: Row = {
          arm,
          task: task.id,
          req: ++req,
          tools: toolCounts[req - 1] ?? -1,
          input: t.input,
          cacheRead,
          cacheWrite,
          output: t.output,
          hit: denom > 0 ? cacheRead / denom : 0,
        }
        rows.push(row)
        console.log(
          `  ${arm.padEnd(5)} ${task.id.padEnd(24)} #${String(row.req).padStart(2)} tools=${String(row.tools).padStart(3)} in=${String(row.input).padStart(6)} read=${String(cacheRead).padStart(6)} write=${String(cacheWrite).padStart(6)} out=${String(t.output).padStart(5)} hit=${(row.hit * 100).toFixed(1)}%`,
        )
      }
    }
  }
  return { rows, calls }
}

function summarize(rows: Row[]) {
  const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0)
  const later = rows.slice(1)
  return {
    requests: rows.length,
    input: sum((r) => r.input),
    cacheRead: sum((r) => r.cacheRead),
    cacheWrite: sum((r) => r.cacheWrite),
    output: sum((r) => r.output),
    uncached: sum((r) => r.input + r.cacheWrite),
    total: sum((r) => r.input + r.cacheRead + r.cacheWrite + r.output),
    avgHitFrom2: later.length ? later.reduce((a, r) => a + r.hit, 0) / later.length : 0,
    /** 工具表件数与上一请求不同的请求数（lazy 臂取回生效的那些） */
    toolSetChanges: rows.filter((r, i) => i > 0 && r.tools !== rows[i - 1]?.tools).length,
  }
}

const outDir = new URL("./out/", import.meta.url)
mkdirSync(outDir, { recursive: true })
console.log(
  `模型 ${bound.model.provider}/${bound.model.id}（${provider}）  工具 ${tools.length} 件  任务 ${TASKS.length} 个`,
)
const results: Record<string, unknown> = {}
for (const arm of (which === "all" ? ["eager", "lazy"] : [which]) as ("eager" | "lazy")[]) {
  console.log(`\n== ${arm} ==`)
  const { rows, calls } = await runArm(arm)
  const summary = summarize(rows)
  results[arm] = { rows, calls, summary }
  console.log(
    `  汇总 ${arm}: 请求 ${summary.requests}  input ${summary.input}  cacheRead ${summary.cacheRead}  cacheWrite ${summary.cacheWrite}  output ${summary.output}  未命中(input+write) ${summary.uncached}  总 ${summary.total}  第2请求起均命中 ${(summary.avgHitFrom2 * 100).toFixed(1)}%  工具表变动 ${summary.toolSetChanges} 次`,
  )
  console.log(`  调用：${calls.join("  ")}`)
  writeFileSync(
    new URL(`${provider}-${modelId}-${arm}.json`, outDir),
    `${JSON.stringify({ provider, model: bound.model, arm, rows, calls, summary }, null, 2)}\n`,
  )
}
