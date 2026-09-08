/**
 * 回放：只凭一份事件日志（JSONL），重现"发生过什么"和"每一轮模型看到了什么"。不需要 API key，不联网。
 *
 *   node examples/minimal/replay.ts <session.jsonl> [--html 输出.html]
 *
 * 三步：
 * 1. 逐行 registry.read —— 读时升级 schema，未登记的类型或未来版本直接拒绝（fail-closed）
 * 2. 整批 append 进一个全新的内存 EventLog —— 由存储层校验 seq 连续、同会话，证明这份日志是自洽的
 * 3. replayTurns —— 对每一轮重算投影（纯函数），再经降级层 toRequest 得到当时的有损落点
 * 终端打一份时间线；给 --html 就再生成一个零依赖的静态页面。
 */
import { readFile, writeFile } from "node:fs/promises"
import {
  createCoreRegistry,
  type Event,
  lossesOf,
  memoryStore,
  type ReplayedTurn,
  replayTurns,
  toolSpecOf,
} from "reins"
import { agent } from "./agent.ts"

const [, , input, ...rest] = process.argv
if (!input) {
  console.error("用法：node examples/minimal/replay.ts <session.jsonl> [--html 输出.html]")
  process.exit(1)
}
const htmlOut = rest[rest.indexOf("--html") + 1]
if (rest.includes("--html") && !htmlOut) {
  console.error("--html 后面要跟输出路径")
  process.exit(1)
}

// ---- 1. 读 + 升级 ----
const registry = createCoreRegistry()
const lines = (await readFile(input, "utf8")).split("\n").filter((l) => l.trim() !== "")
const events = lines.map((line, i) => {
  try {
    return registry.read(JSON.parse(line))
  } catch (err) {
    throw new Error(`第 ${i + 1} 行读不出来：${err instanceof Error ? err.message : String(err)}`)
  }
})
if (events.length === 0) {
  console.error("日志为空")
  process.exit(1)
}

// ---- 2. 灌进新日志 ----
const { log } = memoryStore()
await log.append(events) // seq 不连续或混了别的会话会在这里被拒绝
const sessionId = (events[0] as Event).sessionId
const timeline: Event[] = []
for await (const e of log.read(sessionId)) timeline.push(e)

// ---- 3. 逐轮重算 ----
const { model, lowering, tools = [], systemPrompt } = agent.definition
const capabilities = lowering.capabilities(model)
const { turns, preamble } = replayTurns(timeline, { budget: { contextLimit: capabilities.contextWindow } })
const toolSpecs = tools.map(toolSpecOf)
const landingsOf = (turn: ReplayedTurn) => {
  const req = lowering.toRequest({
    events: turn.visible,
    tools: toolSpecs,
    model,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  })
  const losses = lossesOf(req)
  return {
    exact: req.landings.length - losses.length,
    lossy: losses.filter((l) => l.kind === "lossy").length,
    dropped: losses.filter((l) => l.kind === "dropped").length,
    notes: losses.map((l) => `${l.type.replace("core.", "")} → ${l.landing}${l.note ? `（${l.note}）` : ""}`),
  }
}

// ---- 终端时间线 ----
const t0 = (timeline[0] as Event).at
const tLast = (timeline.at(-1) as Event).at
const rel = (at: number) => `+${((at - t0) / 1000).toFixed(2)}s`
const count = (type: string) => timeline.filter((e) => e.type === type).length
const usage = turns.reduce(
  (acc, t) => ({ input: acc.input + (t.usage?.tokens.input ?? 0), output: acc.output + (t.usage?.tokens.output ?? 0) }),
  { input: 0, output: 0 },
)

/** 一行能看懂的内容摘要；完整载荷在 HTML 里点开看 */
function preview(e: Event): string {
  const p = e.payload as Record<string, unknown>
  const text = (parts: unknown) =>
    Array.isArray(parts)
      ? parts.map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join(" ")
      : String(parts)
  switch (e.type) {
    case "core.user_message":
      return text(p.content)
    case "core.model_text":
      return String(p.text)
    case "core.model_thinking":
      return `（思考 ${String(p.text).length} 字）${String(p.text)}`
    case "core.tool_call":
      return `${p.name} ${JSON.stringify(p.args)}`
    case "core.tool_result":
      return `${p.name} → ${p.isError ? "❌ " : ""}${text(p.content)}`
    case "core.approval_request":
      return `${p.summary}（策略 ${p.policyId}）`
    case "core.approval_decision":
      return `${p.approved ? "批准" : "拒绝"}，by ${p.by}`
    case "core.budget_usage": {
      const tk = p.tokens as { input: number; output: number }
      return `in ${tk.input} / out ${tk.output} · 工具 ${p.toolCalls} 次 · ${p.wallMs}ms`
    }
    case "core.run_paused":
      return `原因 ${p.reason}`
    case "core.run_resumed":
      return p.by ? `by ${p.by}` : ""
    case "core.system_note":
      return `[${p.kind}] ${p.text}`
    case "core.compaction":
      return `折叠 seq ${(p.coversSeq as number[]).join("~")}：${p.summary}`
    case "core.error":
      return `${p.category}：${p.message}`
    default:
      return JSON.stringify(p)
  }
}
const oneLine = (s: string, max = 90) => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
const row = (e: Event) =>
  `${String(e.seq).padStart(4)}  ${rel(e.at).padStart(9)}  ${e.actor.padEnd(6)} ${e.type.replace("core.", "").padEnd(17)} ${oneLine(preview(e))}`

const turnLandings = turns.map(landingsOf)
console.log(`会话 ${sessionId} · 模型 ${model.provider}/${model.id}`)
console.log(
  `${timeline.length} 条事件 · ${turns.length} 轮模型调用 · ${count("core.tool_call")} 次工具 · ${count("core.approval_request")} 次审批 · 用时 ${((tLast - t0) / 1000).toFixed(1)}s · tokens in ${usage.input} / out ${usage.output}`,
)
console.log()
for (const e of preamble) console.log(row(e))
turns.forEach((t, i) => {
  const l = turnLandings[i] as ReturnType<typeof landingsOf>
  const seqs = t.visible.map((e) => e.seq)
  const lossText = l.lossy + l.dropped > 0 ? ` · 有损 ${l.lossy} / 丢弃 ${l.dropped}` : " · 全部 exact"
  console.log(
    `──── 第 ${t.index} 轮 · 模型看到 ${t.visible.length} 条（seq ${seqs[0]}~${seqs.at(-1)}，约 ${t.stats.estimatedTokens} token / 窗口 ${capabilities.contextWindow}）${lossText}${t.diverged ? " · ⚠ 重算与当时不一致" : ""}`,
  )
  for (const n of l.notes) console.log(`      ↳ ${n}`)
  for (const e of [...t.output, ...t.aftermath]) console.log(row(e))
})

// ---- 静态 HTML ----
if (htmlOut) {
  const template = await readFile(new URL("./replay.html", import.meta.url), "utf8")
  const data = {
    sessionId,
    model,
    contextWindow: capabilities.contextWindow,
    events: timeline,
    turns: turns.map((t, i) => ({
      index: t.index,
      requestAtSeq: t.requestAtSeq,
      visibleSeqs: t.visible.map((e) => e.seq),
      estimatedTokens: t.stats.estimatedTokens,
      diverged: t.diverged,
      usage: t.usage ?? null,
      landings: turnLandings[i],
      firstOutputSeq: t.output[0]?.seq ?? null,
    })),
  }
  // 塞进 <script type="application/json">，把 < 转义掉以防 </script> 提前闭合
  const json = JSON.stringify(data).replace(/</g, "\\u003c")
  await writeFile(htmlOut, template.replace("__REPLAY_DATA__", json))
  console.log(`\n✓ 回放页面 → ${htmlOut}`)
}
