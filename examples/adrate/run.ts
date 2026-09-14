/**
 * 跑一条 AdRate 长任务并录下整条时间线。
 *
 *   node examples/adrate/run.ts "<任务>" [--session <id>] [--approve-all] [--out <jsonl>]
 *
 * 循环：run → 暂停等审批就把每条请求打出来，逐条问 y/n（--approve-all 全批）→ 带 decisions 续跑 → 直到 done / error /
 * handoff / 预算暂停。结束后把日志写成 JSONL，并用 examples/minimal/replay.ts 生成回放页面。
 */
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { createInterface } from "node:readline/promises"
import type { ApprovalDecisionInput, Event, RunResult } from "@reinsjs/agent"
import { agent } from "./agent.ts"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const input = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1]?.startsWith("--")))
const approveAll = args.includes("--approve-all")
let sessionId = flag("--session")
if (!input && !sessionId) {
  console.error('用法：node examples/adrate/run.ts "<任务>" [--session <id>] [--approve-all] [--out <jsonl>]')
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
      return oneLine(`${p.name} → ${p.isError ? "❌ " : ""}${(p.content as { text?: string }[]).map((c) => c.text ?? "[image]").join(" ")}`)
    case "core.system_note":
      return oneLine(`[${p.kind}] ${p.text}`)
    case "core.budget_usage": {
      const t = p.tokens as { input: number; output: number; cacheRead?: number }
      return `in ${t.input} + cache ${t.cacheRead ?? 0} / out ${t.output}`
    }
    default:
      return oneLine(JSON.stringify(p))
  }
}

async function runOnce(options: Parameters<typeof agent.run>[0]): Promise<RunResult> {
  const gen = agent.run(options)
  while (true) {
    const step = await gen.next()
    if (step.done) {
      console.log(`  ⏹ ${step.value.status}（lastSeq ${step.value.lastSeq}）`)
      return step.value
    }
    const e = step.value
    console.log(`  ${String(e.seq).padStart(4)}  ${e.actor.padEnd(6)} ${e.type.replace("core.", "").padEnd(17)} ${preview(e)}`)
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
let result = await runOnce({ ...(sessionId ? { sessionId } : {}), ...(input ? { input } : {}) })
sessionId = result.sessionId

while (result.status === "paused" && result.reason === "approval") {
  const approvals = result.interruptions.filter((i) => i.kind === "approval")
  console.log(`\n⏸ ${approvals.length} 项等审批：`)
  const decisions: ApprovalDecisionInput[] = []
  for (const a of approvals) {
    console.log(`  · ${a.request.summary}（策略 ${a.request.policyId}）`)
    let approved = approveAll
    if (!approveAll) {
      const answer = (await rl.question("    批准？[y/N] ")).trim().toLowerCase()
      approved = answer === "y" || answer === "yes"
    }
    decisions.push({ toolCallId: a.toolCallId, approved, by: "boss", ...(approved ? {} : { reason: "Owner 拒绝" }) })
  }
  console.log()
  result = await runOnce({ sessionId, resume: result.state, decisions })
}
rl.close()

if (result.status === "paused") console.log(`\n⏸ 暂停（${result.reason}）：${result.interruptions.map((i) => ("note" in i ? i.note : i.kind)).join("；")}`)
if (result.status === "error") console.log(`\n❌ ${result.error.payload.category}：${result.error.payload.message}`)
if (result.status === "handoff") console.log(`\n↪ 交接到新会话 ${result.toSessionId}`)

// 日志就是全部：一行一个事件
const out = flag("--out") ?? new URL(`./recordings/${sessionId}.jsonl`, import.meta.url).pathname
const events: Event[] = []
for await (const e of agent.definition.log.read(sessionId)) events.push(e)
await mkdir(dirname(out), { recursive: true })
await writeFile(out, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`)
console.log(`\n✓ 会话 ${sessionId} 共 ${events.length} 条事件 → ${out}`)

const html = out.replace(/\.jsonl$/, ".html")
const replay = new URL("../minimal/replay.ts", import.meta.url).pathname
execFileSync("node", [replay, out, "--agent", new URL("./agent.ts", import.meta.url).pathname, "--html", html], { stdio: "inherit" })
