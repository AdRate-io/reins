/**
 * 运行中拉取新输入的真模型行为验证（2026-11-06，OnSet 建议 13，方案 docs/implementation-plans/2026-11-06-运行中拉取新输入.md）。
 *
 * 做法：从 OnSet 样本（docs/archive/2026-11-06-OnSet样本-run中途消息/）重建决策现场，单次请求看模型下一步：
 * - S1 定稿：seq 1–87 → [塞入：背景 + 定稿那一段] → seq 88（pin）→ 调模型（原产出 seq 89）
 * - S2 私信：seq 1–113 → [塞入：私信那一段] → 调模型（原产出 seq 114）
 * 每个现场两臂：insert（按 pullInput 的实现顺序塞入）/ control（不塞）。另有 codeword 一格：背景说明里放口令、
 * 新消息要求复述，看中途 system 位置的背景能否被看到（中转站对中途 system 的处置见踩坑 42）。
 *
 * 系统提示 = OnSet 的 system-prompt.md + 各 Socket 的静态贡献（按样本 README 的装配，经 resolveSocketContributions 算出）；
 * 工具表 = onset-tools.json 31 件 + reins 自带的 compact / memory / recall / fetch_blob。
 *
 * 运行：仓库根 `pnpm build`，然后
 *   DRY=1 node spikes/pull-input-onset/probe.mjs            # 只组请求、打印各现场请求体大小与插入事件的落点，不发
 *   node spikes/pull-input-onset/probe.mjs [gemini|deepseek|all] [N]
 * 每次请求的产出（tool_call 名与入参、正文、用量）落到 OUT_DIR（缺省系统临时目录），不记请求头（不含密钥）。
 * 判据是产出内容不是状态码；汇总表只做关键词初筛，结论以人工逐条看产出为准。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  budget,
  compact,
  haltOnFailure,
  memory,
  perception,
  spill,
  stopAfter,
} from "../../packages/brain/dist/index.js"
import {
  createCoreRegistry,
  createEvent,
  InMemoryEventLog,
  InMemoryMemoryStore,
  project,
  resolveSocketContributions,
  toolSpecOf,
} from "../../packages/core/dist/index.js"
import { anthropicMessages, deepseek } from "../../packages/lowering-fetch/dist/index.js"
import { maybe, need } from "../../scripts/local-env.mjs"

const SAMPLE = new URL("../../docs/archive/2026-11-06-OnSet样本-run中途消息/", import.meta.url)
const read = (f) => readFileSync(new URL(f, SAMPLE), "utf8")
const LOG = read("session-log.jsonl")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
const SYSTEM = read("system-prompt.md")
const ONSET_TOOLS = JSON.parse(read("onset-tools.json"))
const TEXTS = JSON.parse(read("socket-texts.json"))
const SESSION = LOG[0].sessionId
const registry = createCoreRegistry()

const DRY = process.env.DRY === "1"
const WHICH = process.argv[2] ?? "all"
const N = Number(process.argv[3] ?? 10)
const OUT = process.env.OUT_DIR ?? mkdtempSync(join(tmpdir(), "reins-pull-input-"))
mkdirSync(OUT, { recursive: true })

// ---- 模型 ----

function models() {
  const out = []
  if (WHICH === "all" || WHICH === "gemini") {
    out.push({
      name: "gemini-relay",
      bound: anthropicMessages("gemini-3.8-flash-high", {
        provider: "gemini-relay",
        baseUrl: `${DRY ? "https://relay.invalid" : need("RELAY_BASE_URL")}/v1`,
        apiKey: DRY ? "dry" : need("RELAY_GEMINI_API_KEY"),
        reasoning: true,
        images: true,
        contextWindow: 400_000,
        maxOutputTokens: 64_000,
        requestOptions: { max_tokens: 16_000 },
      }),
    })
  }
  if (WHICH === "all" || WHICH === "deepseek") {
    out.push({
      name: "deepseek",
      bound: deepseek("deepseek-v4-flash", {
        apiKey: DRY ? "dry" : (maybe("DEEPSEEK_API_KEY") ?? need("DEEPSEEK_API_KEY")),
        requestOptions: { max_tokens: 16_000 },
      }),
    })
  }
  return out
}

// ---- 现场 ----

const textOf157 = LOG.find((e) => e.seq === 157).payload.content[0].text
const [, signoffPart, dmPart] = textOf157.split(/\n\n(?=▶ )/)
const background156 = LOG.find((e) => e.seq === 156).payload.text

const hostNote = (text) => ({
  type: "core.system_note",
  actor: "host",
  payload: { kind: "host", text, meta: { onsetRunBriefing: true } },
})
const userMsg = (text) => ({
  type: "core.user_message",
  actor: "user",
  payload: { content: [{ type: "text", text }] },
})

const CODEWORD = "青蓑七号"

/** 每个现场：截断位置之前的事件、塞入的草稿、塞入点之后要接上的事件 */
const SITES = {
  S1: {
    before: LOG.filter((e) => e.seq <= 87),
    after: LOG.filter((e) => e.seq === 88),
    inserted: [hostNote(background156), userMsg(`【新消息】共 1 条\n\n${signoffPart}`)],
  },
  S2: {
    before: LOG.filter((e) => e.seq <= 113),
    after: [],
    inserted: [userMsg(`【新消息】共 1 条\n\n${dmPart}`)],
  },
  codeword: {
    before: LOG.filter((e) => e.seq <= 113),
    after: [],
    inserted: [
      hostNote(`【本次背景口令】${CODEWORD}`),
      userMsg(
        `【新消息】共 1 条\n\n${dmPart}\n\n（另：请在正文第一句复述"本次背景口令"是什么；看不到就直说看不到。）`,
      ),
    ],
  },
}

/** 按实现顺序拼出事件并重排 seq（只为单次请求；不进任何日志） */
function timelineOf(site, arm) {
  const t0 = site.before.at(-1).at
  const inserted =
    arm === "insert"
      ? site.inserted.map((d, i) =>
          createEvent(registry, { ...d, sessionId: SESSION, seq: 0, at: t0, id: `pulled-${i}` }),
        )
      : []
  return [...site.before, ...inserted, ...site.after].map((e, i) => ({ ...e, seq: i + 1 }))
}

// ---- 装配：系统提示与工具表 ----

async function contributions(model) {
  const hostTools = ONSET_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    risk: "low",
  }))
  const sockets = [
    haltOnFailure(),
    memory({ rules: TEXTS.MEMORY_RULES_ZH, directories: TEXTS.MEMORY_DIRECTORIES }),
    stopAfter({ tools: ["end_run"] }),
    compact({ rules: TEXTS.COMPACT_RULES_ZH }),
    spill(),
    perception({ limits: { contextTokens: 400_000 } }),
    budget({ limits: { contextTokens: 400_000 } }),
  ]
  return resolveSocketContributions({
    log: new InMemoryEventLog(),
    memory: new InMemoryMemoryStore(),
    model,
    tools: hostTools,
    sockets,
    systemPrompt: SYSTEM,
  })
}

function buildRequest(bound, contrib, timeline) {
  const projected = project({
    timeline,
    budget: { contextLimit: 400_000 },
    registry,
    sessionId: SESSION,
    now: timeline.at(-1).at,
    newId: () => "unused",
  })
  return bound.lowering.toRequest({
    events: projected.events,
    tools: contrib.tools.map(toolSpecOf),
    model: bound.model,
    systemPrompt: contrib.systemPrompt,
  })
}

// ---- 一次请求 ----

async function once(bound, request) {
  const drafts = []
  const stream = bound.lowering.stream(request, {})
  while (true) {
    const step = await stream.next()
    if (step.done) return { drafts, outcome: step.value }
    drafts.push(step.value)
  }
}

function summarize(drafts) {
  const calls = drafts
    .filter((d) => d.type === "core.tool_call")
    .map((d) => ({ name: d.payload.name, args: d.payload.args }))
  const text = drafts
    .filter((d) => d.type === "core.model_text")
    .map((d) => d.payload.text)
    .join("\n")
  return { calls, text }
}

/** 关键词初筛（人工复核为准） */
const SCREENS = {
  S1: (s) => /美术|苏棠|Nano|image2\.5|seedream|性价比|画风方案\s*A|方案\s*A/.test(JSON.stringify(s)),
  S2: (s) => /重复|林晚.{0,20}(建|记忆)|出品人口径/.test(JSON.stringify(s)),
  codeword: (s) => s.text.includes(CODEWORD),
}

async function pool(tasks, size) {
  const results = []
  let next = 0
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < tasks.length) {
        const i = next++
        results[i] = await tasks[i]()
      }
    }),
  )
  return results
}

async function main() {
  const ms = models()
  const plan = []
  for (const m of ms) {
    const contrib = await contributions(m.bound.model)
    for (const [siteName, site] of Object.entries(SITES)) {
      const arms = siteName === "codeword" ? ["insert"] : ["insert", "control"]
      if (siteName === "codeword" && m.name !== "gemini-relay") continue
      for (const arm of arms) {
        const timeline = timelineOf(site, arm)
        const request = buildRequest(m.bound, contrib, timeline)
        const pulledLandings = request.landings.filter((l) => String(l.eventId).startsWith("pulled-"))
        const reps = siteName === "codeword" ? 3 : N
        plan.push({ model: m, siteName, arm, request, reps, pulledLandings })
      }
    }
  }

  for (const p of plan) {
    const size = JSON.stringify(p.request.payload.body).length
    console.log(
      `${p.model.name.padEnd(13)} ${p.siteName.padEnd(9)} ${p.arm.padEnd(8)} body ${size} chars × ${p.reps}`,
      p.pulledLandings.map((l) => `${l.type.replace("core.", "")}→${l.kind}/${l.landing}`).join(", "),
    )
  }
  if (DRY) return

  const tasks = plan.flatMap((p) =>
    Array.from({ length: p.reps }, (_, rep) => async () => {
      const started = Date.now()
      try {
        const { drafts, outcome } = await once(p.model.bound, p.request)
        const s = summarize(drafts)
        const row = {
          model: p.model.name,
          site: p.siteName,
          arm: p.arm,
          rep,
          ms: Date.now() - started,
          ...s,
          outcome,
        }
        writeFileSync(
          join(OUT, `${p.model.name}-${p.siteName}-${p.arm}-${rep}.json`),
          JSON.stringify(row, null, 2),
        )
        return { ...row, hit: SCREENS[p.siteName](s) }
      } catch (err) {
        return {
          model: p.model.name,
          site: p.siteName,
          arm: p.arm,
          rep,
          error: String(err?.message ?? err).slice(0, 300),
        }
      }
    }),
  )
  const rows = await pool(tasks, Number(process.env.CONCURRENCY ?? 8))
  writeFileSync(join(OUT, "rows.json"), JSON.stringify(rows, null, 2))

  console.log(`\n产出目录：${OUT}\n`)
  const groups = new Map()
  for (const r of rows) {
    const k = `${r.model} ${r.site} ${r.arm}`
    const g = groups.get(k) ?? { n: 0, hit: 0, err: 0, first: {}, input: 0, output: 0, cacheRead: 0 }
    g.n++
    if (r.error) g.err++
    else {
      if (r.hit) g.hit++
      const first = r.calls[0]?.name ?? (r.text ? "(text)" : "(empty)")
      g.first[first] = (g.first[first] ?? 0) + 1
      g.input += r.outcome.usage?.input ?? 0
      g.output += r.outcome.usage?.output ?? 0
      g.cacheRead += r.outcome.usage?.cacheRead ?? 0
    }
    groups.set(k, g)
  }
  for (const [k, g] of groups) {
    console.log(
      `${k.padEnd(32)} 初筛命中 ${g.hit}/${g.n - g.err}  错误 ${g.err}  首个动作 ${JSON.stringify(g.first)}  用量 in ${g.input} out ${g.output} cacheRead ${g.cacheRead}`,
    )
  }
  for (const r of rows.filter((x) => x.error)) console.log("ERR", r.model, r.site, r.arm, r.rep, r.error)
}

await main()
