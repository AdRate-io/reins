/**
 * AdRate 建议 13：被中止的一轮（只有思考 / 半个 tool_call / 只有 reasoning 项）回放时厂商收不收。
 *
 * 运行：`node spikes/aborted-turn-replay/probe.mjs [deepseek|cf-chat|cf-responses|all]`；
 * 密钥从仓库根 `.env.local` 读（DEEPSEEK_API_KEY、CF_AIG_TOKEN、CF_ACCOUNT_ID、CF_GATEWAY_ID）。
 *
 * 直接发原始请求体（不经降级层）：要核实的是"候选形状厂商收不收"，不是现有实现发什么。
 * 判据：状态码之外还要看模型确实回了内容（choices / output 非空），400 打出厂商理由。
 *
 * 场景（Chat 线：DeepSeek 官方、OpenAI 经 CF 网关）：
 *   C1 现状复现：assistant 只有 reasoning_content、content null、无 tool_calls → 预期 400
 *   C2 候选修法：整条 assistant 不发，历史里出现 user → user 相邻
 *   C2t 候选修法（停在工具结果之后）：tool → user（中间被跳过的只有思考的一轮）
 *   C3 半个 tool_call：arguments 是截断的 JSON 原文 + "Not executed" 的 tool 结果，再接 user
 *   C3w 半个 tool_call 的替代形状：arguments 包成 {"value": 原文}
 * 场景（Responses 线：OpenAI gpt-5-mini 经 CF 网关，store:false）：
 *   R1 只有 reasoning 项（真加密项，取自同模型第一次请求），其后直接接 user
 *   R3 function_call 的 arguments 是截断原文 + function_call_output，再接 user
 *   R3w 同上但 arguments 包成 {"value": 原文}
 */
import { cfGatewayBase, need } from "../../scripts/local-env.mjs"

const which = process.argv[2] ?? "all"

const TOOL = {
  name: "lookup_price",
  description: "Look up the unit price (USD) of an item in the catalog",
  parameters: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
}
const SYSTEM = "You are a terse assistant. Answer in one short line."
const ASK = "What is the price of a pen? Use lookup_price."
const AFTER = "Never mind the tool. Just reply with the single word OK."
const TRUNCATED = '{"item": "pe'

function chatTarget(name) {
  if (name === "deepseek")
    return {
      url: "https://api.deepseek.com/chat/completions",
      headers: { Authorization: `Bearer ${need("DEEPSEEK_API_KEY")}` },
      model: "deepseek-flash",
      reasoningContent: true,
    }
  return {
    url: `${cfGatewayBase()}/openai/v1/chat/completions`,
    headers: { "cf-aig-authorization": `Bearer ${need("CF_AIG_TOKEN")}` },
    model: "gpt-4o-mini",
    reasoningContent: false,
  }
}

async function post(url, headers, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 3000 * attempt))
      continue
    }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: res.status, text, json }
  }
}

function chatVerdict(r) {
  if (r.status !== 200) return `✗ ${r.status} ${r.text.slice(0, 220)}`
  const msg = r.json?.choices?.[0]?.message
  const said = (msg?.content ?? "").trim() || (msg?.tool_calls ? `[tool_calls ${msg.tool_calls.length}]` : "")
  return said ? `✓ 200 → ${JSON.stringify(said.slice(0, 80))}` : `? 200 但无内容 ${r.text.slice(0, 200)}`
}

async function runChat(name) {
  const t = chatTarget(name)
  const rc = (text) => (t.reasoningContent ? { reasoning_content: text } : {})
  const call = (args) => ({
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_probe_1", type: "function", function: { name: "lookup_price", arguments: args } },
    ],
    ...rc("I should look up the pen price."),
  })
  const notExecuted = {
    role: "tool",
    tool_call_id: "call_probe_1",
    content: "Not executed: the user stopped the run.",
  }
  const base = [
    { role: "system", content: SYSTEM },
    { role: "user", content: ASK },
  ]
  const scenarios = {
    C1: [
      ...base,
      { role: "assistant", content: null, ...rc("User asks for pen price. I need to") },
      { role: "user", content: AFTER },
    ],
    C2: [...base, { role: "user", content: AFTER }],
    C2t: [
      ...base,
      call(JSON.stringify({ item: "pen" })),
      { role: "tool", tool_call_id: "call_probe_1", content: '{"item":"pen","unitPrice":7}' },
      { role: "user", content: AFTER },
    ],
    C3: [...base, call(TRUNCATED), notExecuted, { role: "user", content: AFTER }],
    C3w: [...base, call(JSON.stringify({ value: TRUNCATED })), notExecuted, { role: "user", content: AFTER }],
  }
  for (const [label, messages] of Object.entries(scenarios)) {
    const body = { model: t.model, messages, tools: [{ type: "function", function: TOOL }], max_tokens: 400 }
    const r = await post(t.url, t.headers, body)
    console.log(`[${name}] ${label.padEnd(4)} ${chatVerdict(r)}`)
  }
}

function responsesVerdict(r) {
  if (r.status !== 200) return `✗ ${r.status} ${r.text.slice(0, 260)}`
  const out = r.json?.output ?? []
  const text = out
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .map((c) => c.text ?? "")
    .join("")
    .trim()
  const calls = out.filter((o) => o.type === "function_call").length
  const said = text || (calls ? `[function_call ${calls}]` : "")
  return said ? `✓ 200 → ${JSON.stringify(said.slice(0, 80))}` : `? 200 但无内容 status=${r.json?.status}`
}

async function runResponses() {
  const url = `${cfGatewayBase()}/openai/v1/responses`
  const headers = { "cf-aig-authorization": `Bearer ${need("CF_AIG_TOKEN")}` }
  const model = "gpt-5-mini"
  const common = {
    model,
    instructions: SYSTEM,
    tools: [{ type: "function", ...TOOL }],
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "low" },
    max_output_tokens: 2000,
  }
  // 先拿一个同模型的真加密 reasoning 项
  const first = await post(url, headers, { ...common, input: [{ role: "user", content: ASK }] })
  const reasoning = first.json?.output?.find((o) => o.type === "reasoning" && o.encrypted_content)
  if (!reasoning) {
    console.log(`[cf-responses] 取加密 reasoning 项失败：${first.status} ${first.text.slice(0, 300)}`)
    return
  }
  console.log(
    `[cf-responses] 取到 reasoning 项 ${reasoning.id}（首轮输出项：${first.json.output.map((o) => o.type).join(", ")}）`,
  )
  const call = (args) => ({
    type: "function_call",
    call_id: "call_probe_1",
    name: "lookup_price",
    arguments: args,
  })
  const out = {
    type: "function_call_output",
    call_id: "call_probe_1",
    output: "Not executed: the user stopped the run.",
  }
  const scenarios = {
    R1: [{ role: "user", content: ASK }, reasoning, { role: "user", content: AFTER }],
    R3: [{ role: "user", content: ASK }, call(TRUNCATED), out, { role: "user", content: AFTER }],
    R3w: [
      { role: "user", content: ASK },
      call(JSON.stringify({ value: TRUNCATED })),
      out,
      { role: "user", content: AFTER },
    ],
  }
  for (const [label, input] of Object.entries(scenarios)) {
    const r = await post(url, headers, { ...common, input })
    console.log(`[cf-responses] ${label.padEnd(4)} ${responsesVerdict(r)}`)
  }
}

const jobs = {
  deepseek: () => runChat("deepseek"),
  "cf-chat": () => runChat("cf-chat"),
  "cf-responses": () => runResponses(),
}
const selected = which === "all" ? Object.keys(jobs) : [which]
for (const k of selected) {
  if (!jobs[k]) {
    console.error("用法：node spikes/aborted-turn-replay/probe.mjs [deepseek|cf-chat|cf-responses|all]")
    process.exit(1)
  }
  await jobs[k]()
}
