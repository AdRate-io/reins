/**
 * P1 ⑧：历史里有已移除工具的 tool_call / tool_result 时，两条协议接不接受请求？
 *
 * 场景：用户用过 MCP 服务器上的 check_stock，随后服务器把它删了（或用户卸了那台服务器）。下一次 run 工具表里没有它，
 * 但时间线里还有它的 tool_use / tool_result 块。若上游拒绝，平台策略就得改成"删工具新会话生效"的不对称规则。
 *
 * 两个变体 × 三家上游：
 *   A. 工具表里还有别的工具（lookup_price）        B. 工具表为空（全部移除）
 *   deepseek（Anthropic 协议直连） / aireiter-claude（Anthropic 协议经网关） / aireiter-openai（OpenAI Responses）
 * 判据不是状态码：要看到模型真的产出了回答（有 model_text 且非空）。
 *
 * 运行：仓库根 pnpm build 后 `node spikes/mcp-removed-tool-history/probe.mjs`；密钥自动从《模型API测试信息.md》读。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createCoreEvent, createCoreRegistry } from "../../packages/core/dist/index.js"
import { PiAiLowering } from "../../packages/lowering-pi/dist/index.js"

const info = await readFile(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const gatewayKey = info.match(/密钥（三种协议共用）：`(sk-[^`]+)`/)?.[1]
const deepseekKey = info.match(/DeepSeek 官方[\s\S]*?密钥：`(sk-[^`]+)`/)?.[1]
if (!gatewayKey || !deepseekKey) throw new Error("没在信息文件里找到密钥")

const registry = createCoreRegistry()
const outDir = new URL("./out/", import.meta.url)
await mkdir(outDir, { recursive: true })

const UPSTREAMS = [
  {
    label: "deepseek（Anthropic 协议直连）",
    api: "anthropic-messages",
    baseUrl: "https://api.deepseek.com/anthropic",
    id: "deepseek-v4-flash",
    key: deepseekKey,
  },
  {
    label: "aireiter-claude（Anthropic 协议经网关）",
    api: "anthropic-messages",
    baseUrl: "https://aireiter.com/api",
    id: "claude-sonnet-4-5-20250929",
    key: gatewayKey,
  },
  {
    label: "aireiter-openai（OpenAI Responses）",
    api: "openai-responses",
    baseUrl: "https://aireiter.com/api/v1",
    id: "gpt-5.5",
    key: gatewayKey,
  },
]

const CHECK_STOCK = {
  name: "check_stock",
  description: "Check stock level of an item",
  inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
}
const LOOKUP_PRICE = {
  name: "lookup_price",
  description: "Look up the price of an item",
  inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
}

/** 时间线：用过 check_stock 的一轮 + 新问题。现在工具表里已没有 check_stock */
function timeline(sessionId) {
  let seq = 0
  const push = (draft) => createCoreEvent(registry, { ...draft, sessionId, seq: ++seq })
  return [
    push({
      type: "core.user_message",
      actor: "user",
      payload: { content: [{ type: "text", text: "Item A 还有多少库存？" }] },
    }),
    push({
      type: "core.tool_call",
      actor: "model",
      payload: { toolCallId: "call_1", name: CHECK_STOCK.name, args: { item: "A" } },
    }),
    push({
      type: "core.tool_result",
      actor: "tool",
      payload: {
        toolCallId: "call_1",
        name: "check_stock",
        content: [{ type: "text", text: '{"item":"A","stock":3}' }],
        isError: false,
      },
    }),
    push({ type: "core.model_text", actor: "model", payload: { text: "Item A 还有 3 件。" } }),
    push({
      type: "core.user_message",
      actor: "user",
      payload: {
        content: [
          { type: "text", text: "好。刚才那个数字再说一遍，然后告诉我你现在有哪些工具可用（只列名字）。" },
        ],
      },
    }),
  ]
}

async function probe(up, variant, tools) {
  const sent = []
  const recordingFetch = async (url, init) => {
    const res = await globalThis.fetch(url, init)
    const rec = { url: String(url), status: res.status }
    if (res.status !== 200) rec.error = (await res.clone().text()).slice(0, 800)
    sent.push(rec)
    return res
  }
  const model = {
    provider: "probe",
    id: up.id,
    api: up.api,
    baseUrl: up.baseUrl,
    reasoning: false,
    contextWindow: 128_000,
    maxOutputTokens: 1024,
    images: false,
  }
  const lowering = new PiAiLowering({
    apiKey: () => up.key,
    fetch: recordingFetch,
    models: [model],
    // 不开 thinking：避免"历史 assistant 轮缺 thinking 块"这种无关变量把 400 混进来
    requestOptions: () => ({}),
  })
  const req = lowering.toRequest({
    events: timeline(`probe-${variant}`),
    tools,
    model: { provider: "probe", id: up.id },
    systemPrompt: "You are a terse assistant. Answer in one or two sentences.",
  })
  const drafts = []
  let outcome
  let thrown
  try {
    const gen = lowering.stream(req, {})
    while (true) {
      const step = await gen.next()
      if (step.done) {
        outcome = step.value
        break
      }
      drafts.push(step.value)
    }
  } catch (e) {
    thrown = String(e?.message ?? e).slice(0, 800)
  }
  const text = drafts
    .filter((d) => d.type === "core.model_text")
    .map((d) => d.payload.text)
    .join("")
  const accepted =
    sent.every((s) => s.status === 200) &&
    !thrown &&
    outcome?.stopReason !== "error" &&
    text.trim().length > 0
  return {
    upstream: up.label,
    variant,
    tools: tools.map((t) => t.name),
    accepted,
    http: sent,
    thrown,
    stopReason: outcome?.stopReason,
    errorMessage: outcome?.errorMessage,
    text: text.slice(0, 400),
  }
}

const results = []
for (const up of UPSTREAMS) {
  for (const [variant, tools] of [
    ["A-有别的工具", [LOOKUP_PRICE]],
    ["B-工具表为空", []],
  ]) {
    console.log(`\n▶ ${up.label} / ${variant}`)
    const r = await probe(up, variant, tools)
    results.push(r)
    console.log(
      `  接受=${r.accepted}  HTTP=${r.http.map((h) => h.status).join(",")}  stop=${r.stopReason ?? "-"}`,
    )
    if (r.thrown) console.log(`  抛错：${r.thrown}`)
    if (r.errorMessage) console.log(`  上游错误：${String(r.errorMessage).slice(0, 600)}`)
    for (const h of r.http) if (h.error) console.log(`  错误正文：${h.error}`)
    if (r.text) console.log(`  模型：${r.text.replace(/\s+/g, " ").slice(0, 300)}`)
  }
}
await writeFile(
  new URL("./result.json", outDir),
  JSON.stringify({ 跑于: new Date().toISOString(), results }, null, 2),
)
console.log("\n结果已落盘 spikes/mcp-removed-tool-history/out/result.json")
