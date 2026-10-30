/**
 * 到线请模型整理的门禁（OPT-261030-3 第三步，2026-10-31）：DeepSeek 官方 deepseek-flash，从决策现场出发三步验证，一次并发跑完。
 *
 * ① 会不会整理：wording.ts 的三个现场（截到原请求之前），装真实模块（compact 缺省开请求 + spill + perception + budget，
 *    顺序同 run.ts），maxTurns 1 只走一步，看第一个工具调用是不是 compact。
 * ② 实际整理：compact 在 afterTool 落地，记摘要长度、覆盖区间、decidedBy（应为 forced）。
 * ③ 还记不记得：在整理后的日志上问预埋事实（LATE_FACTS）；同样的问题对未整理的现场也问一遍作对照。
 *    问答同 eval 探针：宿主工具清空、脑子工具保留（可 recall），compact 不再发请求。
 *
 * 门禁：照做 ≥ 5/6，整理后答对率不低于未整理。
 * 补测（Boss 定）：存摘要、看预埋事实在不在摘要里；加一组"机械裁剪后再问"的对照——功能关掉时的真实反面不是不整理，
 * 而是到触发线机械裁剪。做法：问答时把窗口声明成 340k，现场 30 万出头的上下文就越过 85% 触发线、裁到回落线。
 * OPT-261031-1 预验证：`--user-request` 在降级之前把整理请求换成 user 身份 + `<system_note>` 标签（与 lowering-fetch 关掉中途 system 时
 * 的落点逐字相同），其余说明仍走 system——模拟"只这一条按 user 送达"；`--relay` 走公司中转站（OnSet 线路）；`--no-probes` 只跑第 ① 步。
 * 运行：node examples/eval/fixtures/onset-pause/verify-force.ts [--repeats 2] [--relay] [--user-request] [--no-probes]
 * 结果写 examples/eval/out/onset-verify/results.jsonl（只在本地）。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { budget, COMPACT_TOOL_NAME, compact, isCompactRequest, perception, spill } from "@reinsjs/brain"
import { type CoreEventOf, type Event, InMemoryEventLog, runLoop, type Socket, type Tool } from "@reinsjs/core"
import { gradeExpect, parseEventsJsonl, probeAnswerOf } from "@reinsjs/eval"
import { deepseek } from "@reinsjs/lowering-fetch"
import { loadOnsetWorld, ONSET_CONTEXT_WINDOW, ONSET_CUTS, onsetTools } from "./fixture.ts"

const CELLS = new URL("../../out/onset-force/cells/", import.meta.url)
// 同 wording.ts：截到原请求之前；mid 现场再剔掉第一次被无视的请求
const SCENES = [
  { id: "new", cell: "onset-pause-work__force__1", before: 576 },
  { id: "mid", cell: "onset-pause-work__force__3", before: 596, drop: [576] },
  { id: "wrapup", cell: "onset-pause-wrapup__force__2", before: 576 },
] as const
const FACTS = ONSET_CUTS.find((c) => c.id === "onset-pause-work")?.facts ?? []
const PROBE_NOTE =
  "Answer the following question using only what you already know from this conversation. Do not call tools except to bring back a previously spilled or folded tool result. Answer concisely."

const i = process.argv.indexOf("--repeats")
const repeats = i >= 0 ? Number(process.argv[i + 1]) : 2

const INFO = readFileSync(new URL("../../../../模型API测试信息.md", import.meta.url), "utf8")
const relayRoute = process.argv.includes("--relay")
const userRequest = process.argv.includes("--user-request")
const noProbes = process.argv.includes("--no-probes")
const relaySection = INFO.slice(INFO.lastIndexOf("Claude中转"))
const apiKey = relayRoute
  ? relaySection.match(/key[：:]\s*(sk-[A-Za-z0-9_-]+)/)?.[1]
  : INFO.slice(INFO.lastIndexOf("deepseek官方")).match(/key:\s*(sk-[a-z0-9]+)/)?.[1]
const relayBase = relaySection.match(/baseurl[：:]\s*(\S+)/)?.[1]?.replace(/\/+$/, "")
if (!apiKey || (relayRoute && !relayBase)) throw new Error("没在 模型API测试信息.md 找到 key / baseurl")
const modelOf = (contextWindow: number) => {
  const m = relayRoute
    ? deepseek("deepseek-v4.1-flash", { apiKey, baseUrl: `${relayBase}/v1`, contextWindow, maxOutputTokens: 384_000 })
    : deepseek("deepseek-flash", { apiKey, contextWindow, maxOutputTokens: 384_000 })
  if (!userRequest) return m
  // 只把整理请求换成 user 身份的标签文本，其余事件原样
  const toRequest = m.lowering.toRequest.bind(m.lowering)
  m.lowering.toRequest = (input) =>
    toRequest({
      ...input,
      events: input.events.map((e) =>
        isCompactRequest(e)
          ? ({
              ...e,
              type: "core.user_message",
              actor: "user",
              trust: "principal",
              payload: { content: [{ type: "text", text: `<system_note kind="budget">\n${(e as CoreEventOf<"core.system_note">).payload.text}\n</system_note>` }] },
            } as Event)
          : e,
      ),
    })
  return m
}
const model = modelOf(ONSET_CONTEXT_WINDOW)
const NARROW_WINDOW = 340_000
const narrowModel = modelOf(NARROW_WINDOW)

const world = loadOnsetWorld()
const tools = onsetTools(world)
const limits = { contextTokens: ONSET_CONTEXT_WINDOW }
const out = new URL("../../out/onset-verify/", import.meta.url)
mkdirSync(out, { recursive: true })

interface Spent {
  miss: number
  read: number
  out: number
}
const spent: Spent = { miss: 0, read: 0, out: 0 }

async function run(
  log: InMemoryEventLog,
  sessionId: string,
  sockets: Socket[],
  extra: { tools: Tool[]; input?: string; systemPrompt: string; maxTurns: number },
  m = model,
) {
  const fresh: Event[] = []
  let status = "?"
  try {
    const gen = runLoop({ sessionId, log, lowering: m.lowering, model: m.model, sockets, ...extra })
    while (true) {
      const step = await gen.next()
      if (step.done) {
        status = step.value.status
        break
      }
      fresh.push(step.value)
    }
  } catch (err) {
    status = `error: ${err instanceof Error ? err.message : String(err)}`
  }
  for (const e of fresh) {
    if (e.type !== "core.budget_usage") continue
    const t = (e as CoreEventOf<"core.budget_usage">).payload.tokens
    spent.miss += t.input
    spent.read += t.cacheRead ?? 0
    spent.out += t.output
  }
  return { fresh, status }
}

/** ③ 在某条日志上问全部预埋事实：各问题从同一点分叉、并发 */
async function ask(log: InMemoryEventLog, sessionId: string, atSeq: number, tag: string, m = model) {
  const lim = { contextTokens: m === model ? ONSET_CONTEXT_WINDOW : NARROW_WINDOW }
  return Promise.all(
    FACTS.map(async (fact) => {
      const probeId = `${sessionId}~${tag}~${fact.id}`
      await log.fork(sessionId, atSeq, probeId)
      const { fresh, status } = await run(
        log,
        probeId,
        [compact({ force: false }), spill(), perception({ limits: lim }), budget({ limits: lim })],
        { tools: [], input: fact.question, systemPrompt: `${world.systemPrompt}\n\n${PROBE_NOTE}`, maxTurns: 4 },
        m,
      )
      const cut = fresh.find((e) => e.type === "core.compaction") as CoreEventOf<"core.compaction"> | undefined
      const { answer } = probeAnswerOf(fresh)
      const recalled = fresh.some((e) => e.type === "core.tool_call")
      return {
        id: fact.id,
        ok: fact.expect !== undefined && gradeExpect(fact.expect, answer) === 1,
        answer: answer.replace(/\s+/g, " ").slice(0, 80),
        recalled,
        status,
        ...(cut ? { cut: { decidedBy: cut.payload.decidedBy, covers: cut.payload.coversSeq } } : {}),
      }
    }),
  )
}

const lastSeqOf = (events: readonly Event[]) => events.reduce((m, e) => Math.max(m, e.seq), 0)

console.log(`线路 ${relayRoute ? "中转站 deepseek-v4.1-flash" : "官方 deepseek-flash"}，整理请求身份 ${userRequest ? "user 标签" : "system"}`)
const started = Date.now()
const jobs = SCENES.flatMap((scene) => {
  const all = parseEventsJsonl(readFileSync(new URL(`${scene.cell}.jsonl`, CELLS), "utf8"))
  const drop: readonly number[] = "drop" in scene ? scene.drop : []
  const seed = all.filter((e) => e.seq < scene.before && !drop.includes(e.seq)).map((e, k) => ({ ...e, seq: k + 1 }))
  const sessionId = seed[0]?.sessionId as string

  // 对照：未整理的现场直接问
  const control = (async () => {
    if (noProbes) return { scene: scene.id, kind: "control" as const, facts: [] }
    const log = new InMemoryEventLog()
    await log.append(seed)
    return { scene: scene.id, kind: "control" as const, facts: await ask(log, sessionId, lastSeqOf(seed), "control") }
  })()

  const trials = Array.from({ length: repeats }, async (_, r) => {
    const log = new InMemoryEventLog()
    await log.append(seed)
    // ① 一步
    const { fresh, status } = await run(log, sessionId, [compact(), spill(), perception({ limits }), budget({ limits })], {
      tools,
      systemPrompt: world.systemPrompt,
      maxTurns: 1,
    })
    const request = fresh.find(isCompactRequest) as CoreEventOf<"core.system_note"> | undefined
    const calls = fresh.filter((e) => e.type === "core.tool_call").map((e) => (e as CoreEventOf<"core.tool_call">).payload.name)
    // ② 整理落地
    const c = fresh.find((e) => e.type === "core.compaction") as CoreEventOf<"core.compaction"> | undefined
    const compaction = c
      ? {
          decidedBy: c.payload.decidedBy,
          covers: c.payload.coversSeq,
          summaryChars: c.payload.summary.length,
          summary: c.payload.summary,
          // 预埋事实的答案在不在摘要里（只看字符串型 expect）
          inSummary: Object.fromEntries(FACTS.map((f) => [f.id, typeof f.expect === "string" ? c.payload.summary.includes(f.expect) : undefined])),
        }
      : undefined
    // ③ 整理了才问（没整理的那次和对照是同一份上下文，不重复花钱）
    const facts = c && !noProbes ? await ask(log, sessionId, lastSeqOf([...seed, ...fresh]), `t${r + 1}`) : undefined
    return {
      scene: scene.id,
      kind: "trial" as const,
      repeat: r + 1,
      status,
      requested: request ? (request.payload.meta?.compactRequest as { usage: string }).usage : undefined,
      first: calls[0] ?? "（无工具调用）",
      complied: calls[0] === COMPACT_TOOL_NAME,
      compaction,
      facts,
    }
  })
  // 机械裁剪对照：同一现场、窄窗口问答，投影越线裁剪后再答
  const threshold = (async () => {
    if (noProbes) return { scene: scene.id, kind: "threshold" as const, facts: [] }
    const log = new InMemoryEventLog()
    await log.append(seed)
    return { scene: scene.id, kind: "threshold" as const, facts: await ask(log, sessionId, lastSeqOf(seed), "threshold", narrowModel) }
  })()

  return [control, threshold, ...trials]
})

const rows = await Promise.all(jobs)
for (const row of rows) appendFileSync(new URL("results.jsonl", out), `${JSON.stringify(row)}\n`)

// ---- 一次出表 ----
const score = (fs?: readonly { ok: boolean }[]) => (fs ? `${fs.filter((f) => f.ok).length}/${fs.length}` : "—")
console.log("\n① 会不会整理 / ② 整理结果 / ③ 整理后答对")
for (const r of rows) {
  if (r.kind !== "trial") continue
  const cmp = r.compaction ? `${r.compaction.decidedBy} 覆盖 ${r.compaction.covers.join("–")} 摘要 ${r.compaction.summaryChars} 字 摘要含答案 ${JSON.stringify(r.compaction.inSummary)}` : "—"
  console.log(`${r.scene}#${r.repeat}  请求@${r.requested ?? "未发"}  ${r.complied ? "✓ compact" : `✗ ${r.first}`}  ${cmp}  答对 ${score(r.facts)}  ${r.status}`)
  for (const f of r.facts ?? []) console.log(`    ${f.ok ? "✓" : "✗"} ${f.id}${f.recalled ? "（取回）" : ""}：${f.answer}`)
}
for (const [kind, title] of [
  ["control", "③ 对照：未整理现场答对"],
  ["threshold", `③ 对照：机械裁剪后答对（窗口声明 ${NARROW_WINDOW / 1000}k）`],
] as const) {
  console.log(`\n${title}`)
  for (const r of rows) {
    if (r.kind !== kind) continue
    const cut = r.facts.find((f) => "cut" in f && f.cut)
    console.log(`${r.scene}  ${score(r.facts)}  ${cut && "cut" in cut ? `裁剪 ${cut.cut?.decidedBy} 覆盖 ${cut.cut?.covers.join("–")}` : ""}`)
    for (const f of r.facts) console.log(`    ${f.ok ? "✓" : "✗"} ${f.id}${f.recalled ? "（取回）" : ""}：${f.answer}`)
  }
}
const trials = rows.filter((r) => r.kind === "trial")
const after = trials.flatMap((r) => r.facts ?? [])
const before = rows.flatMap((r) => (r.kind === "control" ? r.facts : []))
const cutFacts = rows.flatMap((r) => (r.kind === "threshold" ? r.facts : []))
const rate = (fs: readonly { ok: boolean }[]) => (fs.length ? fs.filter((f) => f.ok).length / fs.length : 0)
console.log(
  `\n门禁：照做 ${trials.filter((r) => r.complied).length}/${trials.length}（要 ≥ ${Math.ceil((trials.length * 5) / 6)}）；` +
    `答对 整理后 ${Math.round(rate(after) * 100)}% vs 未整理 ${Math.round(rate(before) * 100)}% vs 机械裁剪 ${Math.round(rate(cutFacts) * 100)}%`,
)
console.log(`花费 token：未命中 ${spent.miss}  缓存读 ${spent.read}  输出 ${spent.out}  用时 ${Math.round((Date.now() - started) / 1000)}s`)
