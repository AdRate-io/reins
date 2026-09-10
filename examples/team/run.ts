/**
 * 跑一条真实任务并录下父会话与全部子会话。
 *
 *   node examples/team/run.ts "<任务>" [--session <id>] [--approve-all] [--principal <id>] [--out-dir <目录>]
 *
 * 流程：lead.run（principal 缺省 boss）→ 暂停等审批就逐条问 y/n（--approve-all 全批）→ 续跑到底
 * → 从父时间线的 ask_* 结果里找出每个子会话 id → 父、子各写一份 JSONL 到 recordings/。
 */
import { mkdir, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import type { ApprovalDecisionInput, Event, Interruption, RunResult } from "reins"
import { closeStore, EXPERT_TOOL_NAMES, lead, store } from "./agents.ts"
import { childSessionsOf } from "./subagent-tool.ts"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const input = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1]?.startsWith("--")))
const approveAll = args.includes("--approve-all")
const principal = { id: flag("--principal") ?? "boss" }
let sessionId = flag("--session")
if (!input && !sessionId) {
  console.error('用法：node examples/team/run.ts "<任务>" [--session <id>] [--approve-all] [--principal <id>] [--out-dir <目录>]')
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
    case "core.memory_op":
      return oneLine(`${p.op} ${p.path}${p.toPath ? ` → ${p.toPath}` : ""}`)
    case "core.budget_usage": {
      const t = p.tokens as { input: number; output: number; cacheRead?: number }
      return `in ${t.input} + cache ${t.cacheRead ?? 0} / out ${t.output}`
    }
    default:
      return oneLine(JSON.stringify(p))
  }
}

/** 父子会话的事件都会从 lead.run 里 yield 出来（子 run 在工具里跑，但只有父的事件经过父循环）；子会话事件这里看不到，结束后从日志导出 */
async function runOnce(options: { sessionId?: string; input?: string; resume?: RunResult; decisions?: ApprovalDecisionInput[] }) {
  const gen = lead.run({
    principal,
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
    console.log(`  ${String(e.seq).padStart(4)}  ${e.actor.padEnd(6)} ${e.type.replace("core.", "").padEnd(17)} ${preview(e)}`)
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
const startedAt = Date.now()
let result = await runOnce({ ...(sessionId ? { sessionId } : {}), ...(input ? { input } : {}) })
sessionId = result.sessionId
/** 逐条问审批；专家（子代理）冒泡上来的审批带上子会话 id，父续跑时会原样转给专家工具续跑子 run（§10.1） */
async function askAll(interruptions: readonly Interruption[], childSessionId?: string): Promise<ApprovalDecisionInput[]> {
  const decisions: ApprovalDecisionInput[] = []
  for (const i of interruptions) {
    if (i.kind === "subagent") {
      console.log(`  专家会话 ${i.childSessionId} 暂停（${i.reason}）：`)
      decisions.push(...(await askAll(i.interruptions, i.childSessionId)))
      continue
    }
    if (i.kind !== "approval") continue
    const summary = `${i.call.name}(${JSON.stringify(i.call.args)})`
    let approved = approveAll
    if (!approveAll) {
      const answer = await rl.question(`  审批：${summary}  [y/N] `)
      approved = /^y(es)?$/i.test(answer.trim())
    } else console.log(`  审批：${summary}  → 自动批准`)
    decisions.push({
      toolCallId: i.toolCallId,
      approved,
      by: approveAll ? "auto" : principal.id,
      ...(childSessionId !== undefined ? { sessionId: childSessionId } : {}),
    })
  }
  return decisions
}
while (result.status === "paused" && result.reason === "approval") {
  result = await runOnce({ sessionId, resume: result, decisions: await askAll(result.interruptions) })
}
rl.close()

// ---- 导出：父会话 + 顺着 ask_* 结果找到的每个子会话 ----
const outDir = flag("--out-dir") ?? new URL("./recordings/", import.meta.url).pathname
await mkdir(outDir, { recursive: true })
async function dump(id: string): Promise<Event[]> {
  const events: Event[] = []
  for await (const e of store.log.read(id)) events.push(e)
  await writeFile(`${outDir}/${id}.jsonl`, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`)
  return events
}
const parent = await dump(sessionId)
const children = childSessionsOf(parent, EXPERT_TOOL_NAMES)
console.log(`\n父会话 ${sessionId}：${parent.length} 条事件，${((Date.now() - startedAt) / 1000).toFixed(0)}s`)
for (const c of children) {
  const events = await dump(c.childSessionId)
  console.log(
    `  └ ${(c.role ?? "expert").padEnd(8)} ${c.childSessionId}  ${String(events.length).padStart(3)} 条  ${c.status}  ` +
      `tokens in ${c.usage.input}+cache ${c.usage.cacheRead} / out ${c.usage.output}，工具 ${c.usage.toolCalls} 次`,
  )
}
console.log(`已写入 ${outDir}`)
await closeStore()
process.exit(0)
