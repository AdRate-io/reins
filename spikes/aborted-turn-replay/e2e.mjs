/**
 * AdRate 建议 13 端到端：真 runLoop + 真 DeepSeek，在模型思考到一半时真 `abort(new RunStop())`，再在同一会话发"继续"。
 *
 * 运行：仓库根 `pnpm build`，然后 `node spikes/aborted-turn-replay/e2e.mjs [--repeats 3]`；密钥从 `.env.local` 读（DEEPSEEK_API_KEY）。
 *
 * 判据（逐项核对，不看状态码）：
 *   1. 第一段 run 以 paused（stopped）收尾，被停的那一轮日志里只有 core.model_thinking（没有正文、没有 tool_call）——
 *      停得晚了（已出正文或工具调用）这一格不算数，重来；
 *   2. 第二段 run（"继续"）以 done 收尾、有模型正文，日志里没有 core.error；
 *   3. 第二段请求的落点里那条半截思考记 dropped。
 */
import { defineTool, InMemoryEventLog, RunStop, runLoop } from "../../packages/core/dist/index.js"
import { deepseek } from "../../packages/lowering-fetch/dist/index.js"
import { need } from "../../scripts/local-env.mjs"

const ri = process.argv.indexOf("--repeats")
const repeats = ri >= 0 ? Number(process.argv[ri + 1]) : 3

const lookup = defineTool({
  name: "lookup_price",
  description: "Look up the unit price (USD) of an item in the catalog",
  inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
  risk: "low",
  execute: ({ item }) => ({ item, unitPrice: item.toLowerCase().includes("pen") ? 7 : 12 }),
})
const SYSTEM =
  "You are a terse shopping assistant. Use lookup_price when asked about prices. Reply in Chinese."

async function drain(gen, events) {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
    events.push(step.value)
  }
}

async function once(i) {
  const bound = deepseek("deepseek-flash", { apiKey: need("DEEPSEEK_API_KEY") })
  const log = new InMemoryEventLog()
  const sessionId = `aborted-turn-${Date.now()}-${i}`
  const common = {
    sessionId,
    log,
    lowering: bound.lowering,
    model: bound.model,
    tools: [lookup],
    systemPrompt: SYSTEM,
  }

  // ---- 第一段：思考流出 40 字后停止 ----
  const controller = new AbortController()
  let thought = 0
  const first = []
  const r1 = await drain(
    runLoop({
      ...common,
      input: "一支笔和一本笔记本一共多少钱？先仔细想想每件商品该怎么查，再分别查价。",
      signal: controller.signal,
      onDelta: (d) => {
        if (d.kind === "thinking") {
          thought += d.delta.length
          if (thought >= 40 && !controller.signal.aborted) controller.abort(new RunStop())
        } else if (!controller.signal.aborted) controller.abort(new RunStop())
      },
    }),
    first,
  )
  const modelTypes = first.filter((e) => e.actor === "model").map((e) => e.type)
  const thinkingOnly = modelTypes.length > 0 && modelTypes.every((t) => t === "core.model_thinking")
  if (r1.status !== "paused" || !thinkingOnly)
    return {
      ok: undefined,
      note: `第一段不是"只有思考就被停"：status=${r1.status} model=${modelTypes.join(",")}`,
    }

  // ---- 第二段：同一会话发"继续" ----
  const second = []
  let landings
  const r2 = await drain(
    runLoop({
      ...common,
      input: "继续",
      onLandings: (l) => {
        landings ??= l
      },
    }),
    second,
  )
  const errors = second.filter((e) => e.type === "core.error")
  const text = second
    .filter((e) => e.type === "core.model_text")
    .map((e) => e.payload.text)
    .join("")
  const halfway = first.find((e) => e.type === "core.model_thinking")
  const landing = landings?.find((l) => l.eventId === halfway.id)
  const ok = r2.status === "done" && errors.length === 0 && text.length > 0 && landing?.kind === "dropped"
  return {
    ok,
    note: `第二段 status=${r2.status} errors=${errors.map((e) => e.payload.message.slice(0, 120)).join(" | ") || "无"} 半截思考落点=${landing?.kind}/${landing?.landing} 正文=${JSON.stringify(text.slice(0, 60))}`,
  }
}

let pass = 0
let counted = 0
for (let i = 1; counted < repeats && i <= repeats * 3; i++) {
  const r = await once(i)
  console.log(`#${i} ${r.ok === undefined ? "— 不计" : r.ok ? "✓" : "✗"} ${r.note}`)
  if (r.ok === undefined) continue
  counted++
  if (r.ok) pass++
}
console.log(`\n${pass}/${counted}`)
