/**
 * 跑一条真实任务并录下时间线。
 *
 *   node examples/mcp/run.ts "<任务>" [--session <id>] [--approve-all] [--out <jsonl>] [--no-server]
 *
 * 流程：起库存 MCP 服务器（同进程，端口按 mcp.config.json；--no-server 表示你已单独起了）→ 每次 run 前 buildAgent()
 * 现读配置 → 暂停等审批就逐条问 y/n（--approve-all 全批）→ 带 decisions 续跑 → 直到 done / error / handoff / 预算暂停。
 * 结束写 JSONL 到 recordings/。
 */
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { createInterface } from "node:readline/promises"
import type { ApprovalDecisionInput, Event, RunResult } from "@reinsjs/agent"
import { buildAgent, closeMcp, readMcpConfig } from "./agent.ts"
import { startInventoryServer } from "./server.ts"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const input = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1]?.startsWith("--")))
const approveAll = args.includes("--approve-all")
let sessionId = flag("--session")
if (!input && !sessionId) {
  console.error('用法：node examples/mcp/run.ts "<任务>" [--session <id>] [--approve-all] [--out <jsonl>] [--no-server]')
  process.exit(1)
}

const oneLine = (s: string, max = 160) => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
function preview(e: Event): string {
  const p = e.payload as Record<string, unknown>
  switch (e.type) {
    case "core.user_message":
    case "core.model_text":
      return oneLine(String(p.text ?? (p.content as { text?: string }[])?.map((c) => c.text ?? "").join(" ")))
    case "core.model_thinking":
      return `（思考 ${String(p.text).length} 字）`
    case "core.tool_call":
      return oneLine(`${p.name} ${JSON.stringify(p.args)}`)
    case "core.tool_result":
      return oneLine(
        `${p.name} → ${p.isError ? "❌ " : ""}${(p.content as { text?: string }[]).map((c) => c.text ?? "[image]").join(" ")}`,
      )
    case "core.system_note":
      return oneLine(`[${p.kind}] ${p.text}`)
    case "core.tools_bound":
      return oneLine(`工具表：${(p.toolNames as string[]).join(", ")}`)
    case "core.budget_usage": {
      const t = p.tokens as { input: number; output: number; cacheRead?: number }
      return `in ${t.input} + cache ${t.cacheRead ?? 0} / out ${t.output}`
    }
    default:
      return oneLine(JSON.stringify(p))
  }
}

const stopServer = args.includes("--no-server")
  ? undefined
  : await startInventoryServer(Number(new URL(readMcpConfig().servers[0]?.url ?? "http://127.0.0.1:8765").port))

async function runOnce(options: { sessionId?: string; input?: string; resume?: RunResult; decisions?: ApprovalDecisionInput[] }) {
  // 每次 run 都重新装配：配置文件此刻是什么样，这次 run 的工具表就是什么样（连接按配置缓存，见 agent.ts）
  const agent = buildAgent()
  {
    const gen = agent.run({
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.input ? { input: options.input } : {}),
      ...(options.resume?.status === "paused" ? { resume: options.resume.state } : {}),
      ...(options.decisions ? { decisions: options.decisions } : {}),
    })
    while (true) {
      const step = await gen.next()
      if (step.done) {
        console.log(`  ⏹ ${step.value.status}（lastSeq ${step.value.lastSeq}）`)
        return step.value
      }
      const e = step.value
      console.log(
        `  ${String(e.seq).padStart(4)}  ${e.actor.padEnd(6)} ${e.type.replace("core.", "").padEnd(17)} ${preview(e)}`,
      )
    }
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
let result = await runOnce({ ...(sessionId ? { sessionId } : {}), ...(input ? { input } : {}) })
sessionId = result.sessionId
while (result.status === "paused" && result.reason === "approval") {
  const decisions: ApprovalDecisionInput[] = []
  for (const i of result.interruptions) {
    if (i.kind !== "approval") continue
    const summary = `${i.call.name}(${JSON.stringify(i.call.args)})`
    let approved = approveAll
    if (!approveAll) {
      const answer = await rl.question(`  审批：${summary}  [y/N] `)
      approved = /^y(es)?$/i.test(answer.trim())
    } else console.log(`  审批：${summary}  → 自动批准`)
    decisions.push({ toolCallId: i.toolCallId, approved, by: approveAll ? "auto" : "boss" })
  }
  result = await runOnce({ sessionId, resume: result, decisions })
}
rl.close()

const out = flag("--out") ?? new URL(`./recordings/${sessionId}.jsonl`, import.meta.url).pathname
await mkdir(dirname(out), { recursive: true })
const agent = buildAgent()
const lines: string[] = []
for await (const e of agent.definition.log.read(sessionId)) lines.push(JSON.stringify(e))
await writeFile(out, `${lines.join("\n")}\n`)
console.log(`\n会话 ${sessionId}：${lines.length} 条事件已写入 ${out}`)
await closeMcp()
await stopServer?.()
process.exit(0)
