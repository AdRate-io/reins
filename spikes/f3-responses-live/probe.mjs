/**
 * F3 真模型核实：@reinsjs/lowering-fetch 的 OpenAI Responses 线在 core runLoop 上跑一条带工具的多轮，经 Cloudflare AI Gateway
 * 透传路径打官方模型（F0 体检 43/43 已证网关忠实）。
 *
 * 运行：仓库根 `pnpm build`，然后 `node spikes/f3-responses-live/probe.mjs [mini|full|all]`；
 * 配置自动从《模型API测试信息.md》读（CF 网关令牌 / account id / gateway id）。可用 F3_MINI_MODEL / F3_FULL_MODEL 换模型。
 *
 * 判据是产出内容不是状态码（暗号法）：
 *   1. 模型先后调两次工具，最终答案含两次结果之和（19）；
 *   2. 开 reasoning（effort low + summary auto），每轮产出带 encrypted_content 的 reasoning 项；第二个请求起历史里的
 *      reasoning 项被**整项原样回放**且被接受（伪造的 F0 已证 400，所以接受 = 原件）；
 *   3. 运行中途宿主注入的 system_note（暗号）以中途 role:"developer" 到达模型（暗号进最终答案）；
 *   4. 每个请求 store:false、不带 previous_response_id、带 include 加密项；function_call 带 fc_ 项 id 回放，
 *      function_call_output 按 call_id 配对；
 *   5. 系统提示凑过 1024 token，第二个请求起 budget_usage 有 cacheRead > 0（OpenAI 自动前缀缓存的用量被正确换算）；
 *   6. 每轮 budget_usage 有真实用量并算出成本；有损落点只有声明过的几种。
 */
import { readFileSync } from "node:fs"
import { defineTool, InMemoryEventLog, runLoop } from "../../packages/core/dist/index.js"
import { openaiResponses } from "../../packages/lowering-fetch/dist/index.js"

const info = readFileSync(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const cfToken = info.match(/(cfut_[A-Za-z0-9_-]+)/)?.[1]
const cfAccount = info.match(/account id：\s*([a-f0-9]{32})/)?.[1]
const cfGateway = info.match(/gateway id：\s*([\w-]+)/)?.[1] ?? "reins-dev"
if (!cfToken || !cfAccount) throw new Error("信息文件里缺 CF 令牌 / account id")
const BASE = `https://gateway.ai.cloudflare.com/v1/${cfAccount}/${cfGateway}/openai/v1`

const which = process.argv[2] ?? "all"
const CODEWORD = "TAMARIND"

/** 越过 OpenAI 自动缓存的 1024 token 最小前缀 */
const LONG_SYSTEM = `You are a terse assistant. Use lookup_price for every item the user names (one call per item), then answer in one line.\n${"Rule: be exact and brief. ".repeat(300)}`

const gateway = (id, extra) =>
  openaiResponses(id, {
    provider: "openai",
    baseUrl: BASE,
    apiKey: "",
    auth: "none",
    headers: { "cf-aig-authorization": `Bearer ${cfToken}` },
    reasoning: true,
    images: true,
    ...extra,
  })

const TARGETS = {
  mini: () =>
    gateway(process.env.F3_MINI_MODEL ?? "gpt-5-mini", {
      requestOptions: { reasoning: { effort: "low", summary: "auto" }, max_output_tokens: 4096 },
    }),
  full: () =>
    gateway(process.env.F3_FULL_MODEL ?? "gpt-5.4", {
      requestOptions: { reasoning: { effort: "low", summary: "auto" }, max_output_tokens: 4096 },
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
  const caps = bound.lowering.capabilities(bound.model)
  const log = new InMemoryEventLog()
  const events = []
  const requests = []
  let injected = false
  const gen = runLoop({
    sessionId: `f3-${name}-${Date.now()}`,
    log,
    lowering: bound.lowering,
    model: bound.model,
    tools: [lookup],
    systemPrompt: LONG_SYSTEM,
    input:
      "How much do one pen and one notebook cost together? Look up each item separately, then give the total.",
    onLandings: (losses, req) => requests.push({ losses, body: req.payload.body }),
    sockets: [
      {
        id: "spike-inject",
        // 第一批工具结果回来后注入一条宿主说明（暗号）：应以中途 developer 到达
        afterTool: (ctx) => {
          if (!injected) {
            injected = true
            ctx.emit({
              type: "core.system_note",
              actor: "host",
              payload: {
                kind: "host",
                text: `Harness note (from the runtime, not the user): when you give the final answer, append the codeword ${CODEWORD} at the end.`,
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
  const thinkings = events.filter((e) => e.type === "core.model_thinking")
  const usages = events.filter((e) => e.type === "core.budget_usage").map((e) => e.payload.tokens)
  const errors = events.filter((e) => e.type === "core.error").map((e) => e.payload.message)
  const finalText = texts.at(-1) ?? ""
  const lastReq = requests.at(-1)?.body
  const input = lastReq?.input ?? []
  const historyReasoning = input.filter((i) => i.type === "reasoning")
  const historyCalls = input.filter((i) => i.type === "function_call")
  const historyOutputs = input.filter((i) => i.type === "function_call_output")
  const midDeveloper = input.filter((i, idx) => i.role === "developer" && idx > 0)
  const encryptedThinkings = thinkings.filter((t) => {
    try {
      return typeof JSON.parse(t.replay?.thinkingSignature ?? "").encrypted_content === "string"
    } catch {
      return false
    }
  })

  const checks = [
    ["run 正常结束", result?.status === "done", `${result?.status} ${errors.join(" | ")}`],
    [
      "调了两次工具",
      calls.length >= 2,
      `calls=${calls.length} ${calls.map((c) => JSON.stringify(c.payload.args)).join(" ")}`,
    ],
    ["最终答案含总价 19", /19/.test(finalText), finalText.slice(0, 120)],
    [
      "中途注入的 system_note 以 role:developer 到达且暗号出现在最终答案",
      finalText.includes(CODEWORD) && midDeveloper.length >= 1,
      `midDeveloper=${midDeveloper.length} tail=${finalText.slice(-60)}`,
    ],
    [
      "每轮产出带 encrypted_content 的 reasoning 项，且第二个请求起历史里整项原样回放（被接受）",
      thinkings.length >= 1 &&
        encryptedThinkings.length === thinkings.length &&
        historyReasoning.length >= 1 &&
        historyReasoning.every(
          (r) => typeof r.encrypted_content === "string" && r.encrypted_content.length > 0,
        ),
      `thinkings=${thinkings.length} encrypted=${encryptedThinkings.length} inHistory=${historyReasoning.length}`,
    ],
    [
      "每个请求 store:false、无 previous_response_id、带 include 加密项；function_call 带 fc_ 项 id、function_call_output 按 call_id 配对",
      requests.every(
        (r) =>
          r.body.store === false &&
          !("previous_response_id" in r.body) &&
          Array.isArray(r.body.include) &&
          r.body.include.includes("reasoning.encrypted_content"),
      ) &&
        historyCalls.length >= 1 &&
        historyCalls.every((c) => typeof c.id === "string" && c.id.startsWith("fc_") && c.call_id) &&
        historyOutputs.length === historyCalls.length &&
        historyOutputs.every((o) => historyCalls.some((c) => c.call_id === o.call_id)),
      `calls=${historyCalls.map((c) => `${c.id}/${c.call_id}`).join(",")} outputs=${historyOutputs.map((o) => o.call_id).join(",")}`,
    ],
    [
      "第二个请求起 cacheRead > 0（OpenAI 自动前缀缓存的 cached_tokens 换算到位）",
      usages.length >= 2 && usages.slice(1).every((u) => (u.cacheRead ?? 0) > 0),
      JSON.stringify(usages),
    ],
    [
      "每轮 budget_usage 有真实用量",
      usages.length >= 2 &&
        usages.every((u) => u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) > 0 && u.output > 0),
      JSON.stringify(usages),
    ],
    [
      "有损落点只有声明过的几种（工具结果的 untrusted 标记为 exact）",
      requests.every((r) =>
        r.losses.every(
          (l) => l.kind === "dropped" && (l.type === "core.budget_usage" || l.type === "core.tools_bound"),
        ),
      ),
      JSON.stringify(requests.flatMap((r) => r.losses.map((l) => `${l.type}:${l.kind}/${l.landing}`))),
    ],
  ]
  console.log(
    `\n=== ${name} (${bound.model.provider}/${bound.model.id}) thinkingReplay=${caps.thinkingReplay} midConversationSystem=${caps.midConversationSystem} ===`,
  )
  console.log(`事件序列：${types.join(" → ")}`)
  let pass = 0
  for (const [label, ok, detail] of checks) {
    pass += ok ? 1 : 0
    console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  ← ${detail}`}`)
    if (ok && process.env.F3_VERBOSE) console.log(`    ${detail}`)
  }
  if (process.env.F3_VERBOSE) console.log(JSON.stringify(lastReq, null, 1).slice(0, 6000))
  console.log(`${name}: ${pass}/${checks.length}`)
  return pass === checks.length
}

const names = which === "all" ? Object.keys(TARGETS) : TARGETS[which] ? [which] : null
if (!names) {
  console.error("用法：node spikes/f3-responses-live/probe.mjs [mini|full|all]")
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
