/**
 * F1 真模型核实：@reinsjs/lowering-fetch 的 Chat Completions 线在 core runLoop 上跑一条带工具的多轮。
 *
 * 运行：仓库根 `pnpm build`，然后 `node spikes/f1-chat-live/probe.mjs [deepseek|cf-openai|all]`；
 * 密钥自动从《模型API测试信息.md》读（DeepSeek key、CF 网关令牌 / account id / gateway id）。
 *
 * 判据是产出内容不是状态码（暗号法）：
 *   1. 模型先后调两次工具（第二次的请求里历史 assistant 带 tool_calls + 回填的 reasoning_content），最终答案含两次结果之和；
 *   2. 运行中途宿主注入的 system_note（暗号）到达模型；
 *   3. 每轮 budget_usage 有真实用量，DeepSeek 一侧算出成本。
 */
import { readFileSync } from "node:fs"
import { defineTool, InMemoryEventLog, runLoop } from "../../packages/core/dist/index.js"
import { chatCompletions, deepseek } from "../../packages/lowering-fetch/dist/index.js"

const info = readFileSync(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const dsBlock = info.slice(info.lastIndexOf("deepseek官方"))
const dsKey = dsBlock.match(/key:\s*(sk-[a-z0-9]+)/)?.[1]
const cfToken = info.match(/(cfut_[A-Za-z0-9]+)/)?.[1]
const cfAccount = info.match(/account id：\s*([a-f0-9]{32})/)?.[1]
const cfGateway = info.match(/gateway id：\s*([\w-]+)/)?.[1] ?? "reins-dev"
if (!dsKey || !cfToken || !cfAccount) throw new Error("信息文件里缺 DeepSeek key / CF 令牌 / account id")

const which = process.argv[2] ?? "all"
const CODEWORD = "TAMARIND"

const TARGETS = {
  deepseek: () => deepseek(process.env.F1_DEEPSEEK_MODEL ?? "deepseek-flash", { apiKey: dsKey }),
  "cf-openai": () =>
    chatCompletions(process.env.F1_CHAT_MODEL ?? "gpt-4o-mini", {
      provider: "openai",
      baseUrl: `https://gateway.ai.cloudflare.com/v1/${cfAccount}/${cfGateway}/openai/v1`,
      apiKey: "",
      auth: "none",
      headers: { "cf-aig-authorization": `Bearer ${cfToken}` },
      images: true,
    }),
}

const lookup = defineTool({
  name: "lookup_price",
  description: "Look up the unit price (USD) of an item in the catalog",
  inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
  risk: "low",
  execute: ({ item }) => ({ item, unitPrice: item.toLowerCase().includes("pen") ? 7 : 12 }),
})

async function run(name) {
  const bound = TARGETS[name]()
  const log = new InMemoryEventLog()
  const sessionId = `f1-${name}-${Date.now()}`
  const events = []
  const requests = []
  let injected = false
  const gen = runLoop({
    sessionId,
    log,
    lowering: bound.lowering,
    model: bound.model,
    tools: [lookup],
    systemPrompt:
      "You are a terse assistant. Use lookup_price for every item the user names (one call per item), then answer in one line.",
    input:
      "How much do one pen and one notebook cost together? Look up each item separately, then give the total.",
    onLandings: (losses, req) => requests.push({ losses, body: req.payload.body }),
    sockets: [
      {
        id: "spike-inject",
        // 第一批工具结果回来后注入一条宿主说明（暗号），下一轮请求里它应以中途 system 到达
        afterTool: (ctx) => {
          if (!injected) {
            injected = true
            ctx.emit({
              type: "core.system_note",
              actor: "host",
              payload: {
                kind: "host",
                text: `Harness note: when you give the final answer, append the codeword ${CODEWORD} at the end.`,
              },
            })
          }
          return undefined
        },
      },
    ],
  })
  let result
  while (true) {
    const step = await gen.next()
    if (step.done) {
      result = step.value
      break
    }
    events.push(step.value)
  }
  const types = events.map((e) => e.type.replace("core.", ""))
  const texts = events.filter((e) => e.type === "core.model_text").map((e) => e.payload.text)
  const calls = events.filter((e) => e.type === "core.tool_call")
  const usages = events.filter((e) => e.type === "core.budget_usage").map((e) => e.payload.tokens)
  const errors = events.filter((e) => e.type === "core.error").map((e) => e.payload.message)
  const finalText = texts.at(-1) ?? ""
  const lastReq = requests.at(-1)?.body
  const historyAssistants = (lastReq?.messages ?? []).filter((m) => m.role === "assistant")
  const midSystem = (lastReq?.messages ?? []).filter((m, i) => m.role === "system" && i > 0)

  const checks = [
    ["run 正常结束", result?.status === "done", `${result?.status} ${errors.join(" | ")}`],
    [
      "调了两次工具",
      calls.length >= 2,
      `calls=${calls.length} ${calls.map((c) => JSON.stringify(c.payload.args)).join(" ")}`,
    ],
    ["最终答案含总价 19", /19/.test(finalText), finalText.slice(0, 120)],
    ["中途注入的 system_note 暗号到达（最终答案含暗号）", finalText.includes(CODEWORD), finalText.slice(-60)],
    [
      "末次请求里历史 assistant 带 tool_calls，且中途 system 消息在场",
      historyAssistants.some((m) => Array.isArray(m.tool_calls)) && midSystem.length >= 1,
      `assistants=${historyAssistants.length} midSystem=${midSystem.length}`,
    ],
    [
      name === "deepseek"
        ? "DeepSeek：历史 assistant 每条都带 reasoning_content 字段"
        : "OpenAI：历史 assistant 不带 reasoning_content",
      name === "deepseek"
        ? historyAssistants.every((m) => typeof m.reasoning_content === "string")
        : historyAssistants.every((m) => !("reasoning_content" in m)),
      historyAssistants
        .map((m) => (typeof m.reasoning_content === "string" ? `rc(${m.reasoning_content.length})` : "-"))
        .join(","),
    ],
    [
      "每轮 budget_usage 有真实用量",
      usages.length >= 2 && usages.every((u) => u.input > 0 && u.output > 0),
      JSON.stringify(usages),
    ],
    [
      "有损落点只有声明过的几种（tool_result 的 untrusted 标记为 exact）",
      requests.every((r) =>
        r.losses.every(
          (l) => l.kind !== "dropped" || l.type === "core.budget_usage" || l.type === "core.tools_bound",
        ),
      ),
      JSON.stringify(requests.flatMap((r) => r.losses.map((l) => `${l.type}:${l.kind}/${l.landing}`))),
    ],
  ]
  console.log(`\n=== ${name} (${bound.model.provider}/${bound.model.id}) ===`)
  console.log(`事件序列：${types.join(" → ")}`)
  let pass = 0
  for (const [label, ok, detail] of checks) {
    pass += ok ? 1 : 0
    console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  ← ${detail}`}`)
    if (ok && process.env.F1_VERBOSE) console.log(`    ${detail}`)
  }
  console.log(`${name}: ${pass}/${checks.length}`)
  return pass === checks.length
}

const names = which === "all" ? Object.keys(TARGETS) : TARGETS[which] ? [which] : null
if (!names) {
  console.error("用法：node spikes/f1-chat-live/probe.mjs [deepseek|cf-openai|all]")
  process.exit(2)
}
let allOk = true
for (const n of names) {
  try {
    allOk = (await run(n)) && allOk
  } catch (e) {
    allOk = false
    console.log(`✗ ${n} 异常：${e?.message ?? e}`)
  }
}
process.exit(allOk ? 0 : 1)
