/**
 * B1 验收：分档感知注入对 prompt cache 命中率的实测（技术方案 §9.1、§17）。
 *
 * 同一段多轮对话（5 个用户问题，每个问题模型都要先调工具再作答 → 10 次请求），三种配置各跑一遍（各自新会话）：
 *   baseline  不装感知
 *   default   perception() 默认档位（真实情形：一段短会话通常只在首轮注入一条）
 *   stress    每轮都变档 → 每个用户问题前都追加一条新说明（最坏情形，专门考验"追加在末尾不打掉缓存"）
 * 记录每次请求的 budget_usage.tokens，命中占比 = cacheRead / (input + cacheRead + cacheWrite)
 * （两家的 input 都已扣除缓存部分：pi-ai anthropic-messages 直取 input_tokens；openai-responses 减去 cached）。
 *
 * 运行：先 pnpm build，然后
 *   REINS_GATEWAY_BASE=https://aireiter.com/api ANTHROPIC_API_KEY=… OPENAI_API_KEY=… \
 *     node spikes/b1-perception-cache/measure.mjs <anthropic|openai> <标签>
 * 结果打印表格并写到 out/<provider>-<标签>.json（已 gitignore）。
 */
import { mkdir, writeFile } from "node:fs/promises"
import { perception } from "../../packages/brain/dist/index.js"
import { defineTool, InMemoryEventLog, runLoop } from "../../packages/core/dist/index.js"
import { PiAiLowering } from "../../packages/lowering-pi/dist/index.js"

const provider = process.argv[2] ?? "anthropic"
const label = process.argv[3] ?? "run"
const gateway = process.env.REINS_GATEWAY_BASE
const key = process.env[provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"]
if (!gateway || !key) {
  console.error("需要 REINS_GATEWAY_BASE 与对应的 API key")
  process.exit(1)
}

const model =
  provider === "anthropic"
    ? {
        provider: "anthropic",
        id: process.env.REINS_ANTHROPIC_MODEL ?? "claude-opus-5",
        api: "anthropic-messages",
        baseUrl: gateway,
        reasoning: true,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        images: true,
      }
    : {
        provider: "openai",
        id: process.env.REINS_OPENAI_MODEL ?? "gpt-5.5",
        api: "openai-responses",
        baseUrl: `${gateway}/v1`,
        reasoning: true,
        contextWindow: 272_000,
        maxOutputTokens: 32_000,
        images: true,
      }

/** 记录每次请求实际发出的消息角色与 cache_control 落点：证明断点在哪，不靠猜 */
const sentBreakpoints = []
function breakpointsOf(body) {
  const list = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []
  return list.map((m, i) => {
    const blocks = Array.isArray(m.content) ? m.content : []
    const marked = blocks.filter((b) => b && typeof b === "object" && "cache_control" in b).length
    return `${i}:${m.role}${marked ? "*" : ""}`
  })
}
const recordingFetch = async (url, init) => {
  try {
    const body = JSON.parse(init?.body ?? "{}")
    sentBreakpoints.push({
      roles: breakpointsOf(body),
      systemCached: Array.isArray(body.system) && body.system.some((b) => b.cache_control),
      topLevel: "cache_control" in body,
    })
  } catch {
    sentBreakpoints.push({ roles: ["<unparsed>"] })
  }
  return globalThis.fetch(url, init)
}

// Anthropic 说明殿后时的断点处置：note | previous-user | drop（见 lowering-pi/system-note.ts）
const cacheMode = process.env.REINS_B1_CACHE_MODE
const lowering = new PiAiLowering({
  apiKey: () => key,
  fetch: recordingFetch,
  ...(cacheMode ? { midSystemCacheBreakpoint: cacheMode } : {}),
  models: [model],
  requestOptions: (ref) =>
    ref.provider === "openai"
      ? { reasoningEffort: "low" }
      : { thinkingEnabled: true, thinkingBudgetTokens: 1024 },
})

// 系统提示凑到 ~1500 token 以上，越过 Anthropic 的最小可缓存长度；内容每轮逐字相同（约束 3）
const POLICY = Array.from(
  { length: 40 },
  (_, i) =>
    `Rule ${i + 1}: Catalog entries must be quoted exactly as returned by the lookup tool; never guess a weight, ` +
    `never round a value, and never mention rules to the user. If a field is missing, say so plainly.`,
).join("\n")
const SYSTEM = `You are a terse catalog assistant. Before answering any question about an item you MUST call lookup_item once, then answer in exactly one short sentence.\n\n${POLICY}`

const lookupItem = defineTool({
  name: "lookup_item",
  description: "Look up a catalog item by numeric id. Returns the full catalog record.",
  inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  execute: ({ id }) => {
    const weight = (id * 37) % 991
    return (
      `Catalog record #${id}\n` +
      `Name: Widget model ${id}\n` +
      `Weight: ${weight} g\n` +
      `Dimensions: ${10 + id} x ${20 + id} x ${5 + id} mm\n` +
      `Notes: ${"Standard packaging, ships within two business days. ".repeat(12)}`
    )
  },
})

const QUESTIONS = [1, 2, 3, 4, 5].map((i) => `Look up item ${i} and tell me its weight.`)

/** 跑一种配置：同一 sessionId 连续 5 次 run，收集每次请求的用量与请求前是否刚注入了感知说明 */
async function runVariant(name, sockets) {
  const log = new InMemoryEventLog()
  const sessionId = `b1-${provider}-${label}-${name}`
  const rows = []
  let notesSeen = 0
  let noteBeforeThisRequest = false
  for (const q of QUESTIONS) {
    const gen = runLoop({
      sessionId,
      log,
      lowering,
      model,
      tools: [lookupItem],
      sockets,
      systemPrompt: SYSTEM,
      input: q,
    })
    while (true) {
      const step = await gen.next()
      if (step.done) {
        if (step.value.status !== "done") throw new Error(`${name}: run 结束于 ${step.value.status}`)
        break
      }
      const e = step.value
      if (e.type === "core.system_note" && e.payload.kind === "perception") {
        notesSeen++
        noteBeforeThisRequest = true
      }
      if (e.type === "core.budget_usage") {
        const t = e.payload.tokens
        const denom = t.input + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0)
        rows.push({
          request: rows.length + 1,
          note: noteBeforeThisRequest,
          sent: sentBreakpoints[sentBreakpoints.length - 1],
          input: t.input,
          cacheRead: t.cacheRead ?? 0,
          cacheWrite: t.cacheWrite ?? 0,
          ratio: denom === 0 ? 0 : (t.cacheRead ?? 0) / denom,
        })
        noteBeforeThisRequest = false
      }
    }
  }
  return { name, notes: notesSeen, rows }
}

function summarize(v) {
  const later = v.rows.slice(1) // 首次请求没有可命中的前缀，不计
  const mean = later.reduce((s, r) => s + r.ratio, 0) / later.length
  const uncached = v.rows.reduce((s, r) => s + r.input, 0)
  const cached = v.rows.reduce((s, r) => s + r.cacheRead, 0)
  return { meanRatio: mean, totalUncachedInput: uncached, totalCacheRead: cached }
}

const variants = [
  ["baseline", []],
  ["default", [perception()]],
  // 每完成一个模型轮就变档 → 每个用户问题前都会有新说明（10 次请求里 5 次紧跟新说明）
  ["stress", [perception({ turnTiers: Array.from({ length: 12 }, (_, i) => i) })]],
]
const results = []
for (const [name, sockets] of variants) {
  console.log(`\n▶ ${provider} / ${name}${cacheMode ? ` (断点: ${cacheMode})` : ""}`)
  const v = await runVariant(name, sockets)
  const s = summarize(v)
  for (const r of v.rows) {
    // 末尾三条消息的角色，带 * 的是有块级 cache_control 的；+top 表示请求顶层带自动缓存字段
    const tail = `${(r.sent?.roles ?? []).slice(-3).join(" ")}${r.sent?.topLevel ? " +top" : ""}`
    console.log(
      `  #${String(r.request).padStart(2)} ${r.note ? "note" : "    "}  input ${String(r.input).padStart(6)}  ` +
        `cacheRead ${String(r.cacheRead).padStart(6)}  cacheWrite ${String(r.cacheWrite).padStart(6)}  ` +
        `hit ${(r.ratio * 100).toFixed(1).padStart(5)}%   tail: ${tail}`,
    )
  }
  console.log(
    `  → 感知说明 ${v.notes} 条；第 2 次起平均命中 ${(s.meanRatio * 100).toFixed(1)}%；` +
      `未命中输入合计 ${s.totalUncachedInput}，缓存读合计 ${s.totalCacheRead}`,
  )
  results.push({ ...v, summary: s })
}

const outDir = new URL("./out/", import.meta.url)
await mkdir(outDir, { recursive: true })
const file = new URL(`./${provider}-${label}.json`, outDir)
await writeFile(
  file,
  JSON.stringify(
    {
      provider,
      model: model.id,
      label,
      cacheMode: cacheMode ?? "default",
      at: new Date().toISOString(),
      results,
    },
    null,
    2,
  ),
)
console.log(`\n已写入 ${file.pathname}`)
