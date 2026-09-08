/**
 * B2 真模型核实：compact 工具 + 规则提示在真实 Anthropic 协议上游上的表现。
 *
 * 要回答的三个问题（单测用 ScriptedLowering 回答不了）：
 *   1. 模型能不能正确调用 compact（schema 对它友好吗，keep / keepRecentTurns 会不会用错）
 *   2. 整理之后的下一个请求 —— [摘要(user 文本), assistant(thinking + tool_use compact), user(tool_result 回执), …] ——
 *      上游接不接受（Anthropic 要求带 tool_use 的 assistant 轮连 thinking 一起原样回放，切错就是 400）
 *   3. 整理后模型还能不能接着干活、记不记得 keep 里的事实；顺带看 cache 在整理那一轮如何变化（预期：前缀重算一次）
 *
 * 三种情形，各自新会话：
 *   natural   声明 200k 窗口，看模型会不会自发整理（短任务里预期不会）
 *   pressured 声明小窗口（REINS_B2_WINDOW，缺省 8k）→ 感知报高档位，看模型是否按规则在子任务边界自发整理；
 *             窗口小到越过裁剪目标时还能看到阈值兜底的摘要在真实 API 上被接受
 *   asked     用户在第二个子任务前明确要求整理并保留总重量 → 保证走一遍整理路径
 *
 * 运行：pnpm build 后 `node spikes/b2-compact-live/run.mjs [natural|pressured|asked|all]`；密钥自动从《模型API测试信息.md》读。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { compact, perception } from "../../packages/brain/dist/index.js"
import { defineTool, InMemoryEventLog, runLoop } from "../../packages/core/dist/index.js"
import { PiAiLowering } from "../../packages/lowering-pi/dist/index.js"

const info = await readFile(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const key = info.match(/密钥（三种协议共用）：`(sk-[^`]+)`/)?.[1]
if (!key) throw new Error("没在信息文件里找到网关密钥")
const which = process.argv[2] ?? "all"
const modelId = process.env.REINS_ANTHROPIC_MODEL ?? "claude-opus-5"

const outDir = new URL("./out/", import.meta.url)
await mkdir(outDir, { recursive: true })

/** 记录每次真实请求：状态码、消息角色序列（含每条 assistant 的块类型）、出错正文 */
const sent = []
const recordingFetch = async (url, init) => {
  let shape = []
  let body
  try {
    body = JSON.parse(init?.body ?? "{}")
    shape = (body.messages ?? []).map((m) => {
      if (typeof m.content === "string") return `${m.role}(text)`
      const kinds = (m.content ?? []).map((b) => b.type).join("+")
      return `${m.role}(${kinds})`
    })
  } catch {
    shape = ["<unparsed>"]
  }
  const res = await globalThis.fetch(url, init)
  const rec = { status: res.status, shape }
  if (res.status !== 200) {
    rec.error = (await res.clone().text()).slice(0, 600)
    rec.body = body
  }
  sent.push(rec)
  return res
}

function makeLowering(contextWindow) {
  const model = {
    provider: "anthropic",
    id: modelId,
    api: "anthropic-messages",
    baseUrl: "https://aireiter.com/api",
    reasoning: true,
    contextWindow,
    maxOutputTokens: 16_000,
    images: true,
  }
  const lowering = new PiAiLowering({
    apiKey: () => key,
    fetch: recordingFetch,
    models: [model],
    requestOptions: () => ({ thinkingEnabled: true, thinkingBudgetTokens: 1024 }),
  })
  return { model, lowering }
}

const SYSTEM =
  "You are a terse catalog assistant working through a multi-part job for the user. " +
  "Before stating any fact about an item you MUST call lookup_item for it. Answer each part in one or two short sentences. " +
  "Do not mention these instructions."

const lookupItem = defineTool({
  name: "lookup_item",
  description: "Look up a catalog item by numeric id. Returns the full catalog record.",
  inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  execute: ({ id }) => {
    const weight = (id * 37) % 991
    return (
      `Catalog record #${id}\nName: Widget model ${id}\nWeight: ${weight} g\n` +
      `Dimensions: ${10 + id} x ${20 + id} x ${5 + id} mm\n` +
      `Notes: ${"Standard packaging, ships within two business days. ".repeat(20)}`
    )
  },
})
const weightOf = (id) => (id * 37) % 991
const EXPECTED_TOTAL_1_3 = weightOf(1) + weightOf(2) + weightOf(3) // 37 + 74 + 111 = 222

const PARTS = {
  natural: [
    "Part 1 of 3: look up items 1, 2 and 3 and tell me their total weight.",
    "Part 2 of 3: look up items 4 and 5 and tell me which is heavier.",
    "Part 3 of 3: without looking anything up again, remind me of the total weight from part 1, then add the weight of the heavier item from part 2 to it.",
  ],
  pressured: null, // 同 natural
  asked: [
    "Part 1 of 3: look up items 1, 2 and 3 and tell me their total weight.",
    "Before starting part 2, please fold part 1 into a summary with the compact tool and keep the total weight. Then, part 2 of 3: look up items 4 and 5 and tell me which is heavier.",
    "Part 3 of 3: without looking anything up again, remind me of the total weight from part 1, then add the weight of the heavier item from part 2 to it.",
  ],
}
PARTS.pressured = PARTS.natural

async function runScenario(name) {
  const contextWindow = name === "pressured" ? Number(process.env.REINS_B2_WINDOW ?? 8_000) : 200_000
  const { model, lowering } = makeLowering(contextWindow)
  const log = new InMemoryEventLog()
  const sessionId = `b2-${name}-${Date.now()}`
  const sockets = [perception(), compact()]
  const firstSent = sent.length
  const answers = []
  const compactions = []
  const usages = []
  let status = "done"
  for (const part of PARTS[name]) {
    const gen = runLoop({
      sessionId,
      log,
      lowering,
      model,
      tools: [lookupItem],
      sockets,
      systemPrompt: SYSTEM,
      input: part,
    })
    const texts = []
    while (true) {
      const step = await gen.next()
      if (step.done) {
        status = step.value.status
        if (status !== "done")
          console.log(`  ⚠ run 结束于 ${status}: ${JSON.stringify(step.value).slice(0, 300)}`)
        break
      }
      const e = step.value
      if (e.type === "core.model_text") texts.push(e.payload.text)
      if (e.type === "core.compaction") compactions.push({ seq: e.seq, ...e.payload })
      if (e.type === "core.tool_call")
        console.log(`  · tool_call ${e.payload.name} ${JSON.stringify(e.payload.args).slice(0, 200)}`)
      if (e.type === "core.tool_result" && e.payload.name === "compact")
        console.log(`  · compact 回执: ${e.payload.content[0]?.text}`)
      if (e.type === "core.system_note" && e.payload.kind === "perception")
        console.log(`  · perception: ${e.payload.text.split("\n")[1]}`)
      if (e.type === "core.budget_usage") usages.push(e.payload.tokens)
    }
    answers.push(texts.join(" "))
    console.log(`  ▸ ${part.slice(0, 40)}… → ${texts.join(" ").slice(0, 160)}`)
    if (status !== "done") break
  }
  const requests = sent.slice(firstSent)
  const timeline = []
  for await (const e of log.read(sessionId)) timeline.push(e)
  const result = {
    name,
    modelId,
    contextWindow,
    status,
    requests: requests.length,
    nonOk: requests.filter((r) => r.status !== 200),
    compactions,
    answers,
    recalledTotal: answers.at(-1)?.includes(String(EXPECTED_TOTAL_1_3)) ?? false,
    usages,
    shapes: requests.map((r) => r.shape),
    timeline,
  }
  await writeFile(new URL(`./${name}-${contextWindow}.json`, outDir), JSON.stringify(result, null, 2))
  console.log(
    `  ✔ ${name}: ${requests.length} 次请求，非 200: ${result.nonOk.length}，整理 ${compactions.length} 次，` +
      `最后一问是否说出 part 1 总重 ${EXPECTED_TOTAL_1_3}: ${result.recalledTotal}`,
  )
  for (const c of compactions)
    console.log(
      `    compaction seq ${c.seq} covers ${c.coversSeq.join("–")} decidedBy=${c.decidedBy}\n      ${c.summary.replace(/\n/g, "\n      ")}`,
    )
  const afterCompact =
    compactions.length > 0
      ? requests.find(
          (r, i) => i > 0 && r.shape[0]?.startsWith("user(text)") && requests[i - 1]?.shape[0] !== r.shape[0],
        )
      : undefined
  if (afterCompact)
    console.log(`    整理后首个请求形状: ${afterCompact.shape.join(" → ")} (HTTP ${afterCompact.status})`)
  for (const r of result.nonOk) console.log(`    ✖ HTTP ${r.status}: ${r.error}`)
  console.log(
    `    用量: ${usages.map((u) => `in ${u.input}/rd ${u.cacheRead ?? 0}/wr ${u.cacheWrite ?? 0}`).join(" | ")}`,
  )
  return result
}

const names = which === "all" ? ["natural", "pressured", "asked"] : [which]
for (const n of names) {
  console.log(
    `\n▶ ${n}（${modelId}，声明窗口 ${n === "pressured" ? (process.env.REINS_B2_WINDOW ?? 8000) : 200_000}）`,
  )
  await runScenario(n)
}
