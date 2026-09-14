/**
 * L1 端到端：`runLoop + lazyTools() + @reinsjs/lowering-fetch` 的 Anthropic 线经 CF 网关打官方模型，原生延迟加载全栈验证。
 *
 * 判据（产出内容，不看状态码）：
 *   1. 每个请求的 tools 块都是全表（3 件菜单工具 + today + tool_find），菜单工具 defer_loading，断点不落在延迟工具上；
 *   2. 模型先 tool_find 再调 get_weather；tool_find 的 tool_result 里是 tool_reference 块、说明文字跟在这批结果之后；
 *   3. 取回后的第 2、3 个请求 cacheRead > 0（工具表整段不变）；
 *   4. 同一会话第二次 run（新问题 Tokyo）：模型直接调 get_weather 不再取回（已取回集合从时间线重建，厂商从历史展开引用）；
 *   5. 有损落点只有声明过的：tool-reference lossy（说明文字改放之后）、budget_usage / tools_bound dropped。
 *
 * 运行：仓库根 `pnpm build`，然后 `node spikes/l1-deferred-tools/live.mjs [haiku|opus]`；配置自动从《模型API测试信息.md》读。
 */
import { readFileSync } from "node:fs"
import { lazyTools } from "../../packages/brain/dist/index.js"
import { defineTool, InMemoryEventLog, runLoop } from "../../packages/core/dist/index.js"
import { anthropicMessages } from "../../packages/lowering-fetch/dist/index.js"

const info = readFileSync(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const cfToken = info.match(/(cfut_[A-Za-z0-9_-]+)/)?.[1]
const cfAccount = info.match(/account id：\s*([a-f0-9]{32})/)?.[1]
const cfGateway = info.match(/gateway id：\s*([\w-]+)/)?.[1] ?? "reins-dev"
if (!cfToken || !cfAccount) throw new Error("信息文件里缺 CF 令牌 / account id")
const BASE = `https://gateway.ai.cloudflare.com/v1/${cfAccount}/${cfGateway}/anthropic/v1`

const which = process.argv[2] ?? "haiku"
const MODEL_ID = which === "opus" ? "claude-opus-5" : "claude-haiku-4-5-20251001"
const SALT = `run-${Date.now().toString(36)}`
/** Haiku 4.5 最小可缓存 4096 token；加盐防上一遍的缓存串进来 */
const SYSTEM = `You are a terse assistant (session ${SALT}). Answer in one line.\n${"Rule: be exact and brief. ".repeat(which === "opus" ? 300 : 1100)}`

const bound = anthropicMessages(MODEL_ID, {
  provider: "anthropic",
  baseUrl: BASE,
  apiKey: "",
  auth: "none",
  headers: { "cf-aig-authorization": `Bearer ${cfToken}` },
  requestOptions: { max_tokens: 1024 },
})

const lazy = (name, description, props) =>
  defineTool({
    name,
    description,
    inputSchema: { type: "object", properties: props, required: Object.keys(props) },
    risk: "low",
    lazy: true,
    execute: (input) => ({
      tool: name,
      input,
      answer: name === "get_weather" ? "22°C, sunny, light wind" : "ok",
    }),
  })
const tools = [
  defineTool({
    name: "today",
    description: "Today's date",
    inputSchema: { type: "object", properties: {} },
    risk: "low",
    execute: () => "2026-09-15",
  }),
  lazy("get_weather", "Get the current weather at a location", { location: { type: "string" } }),
  lazy("search_files", "Search through files in the workspace by keyword", { query: { type: "string" } }),
  lazy("check_stock", "Check the stock level of an item in the warehouse", { item: { type: "string" } }),
]

async function run(log, sessionId, input, requests) {
  const events = []
  const gen = runLoop({
    sessionId,
    log,
    lowering: bound.lowering,
    model: bound.model,
    tools,
    systemPrompt: SYSTEM,
    input,
    sockets: [lazyTools()],
    onLandings: (losses, req) => requests.push({ losses, body: req.payload.body }),
  })
  while (true) {
    const step = await gen.next()
    if (step.done) return { events, result: step.value }
    events.push(step.value)
  }
}

const caps = bound.lowering.capabilities(bound.model)
const log = new InMemoryEventLog()
const sessionId = `l1-live-${Date.now()}`
const requests = []
const first = await run(log, sessionId, "What is the weather in Paris right now? Use the tools.", requests)
const firstRequestCount = requests.length
const second = await run(log, sessionId, "And in Tokyo?", requests)

const calls = (r) =>
  r.events.filter((e) => e.type === "core.tool_call").map((e) => [e.payload.name, e.payload.args])
const texts = (r) => r.events.filter((e) => e.type === "core.model_text").map((e) => e.payload.text)
const usages = (from, to) =>
  [...first.events, ...second.events]
    .filter((e) => e.type === "core.budget_usage")
    .map((e) => e.payload.tokens)
    .slice(from, to)
const deferredOf = (body) =>
  Object.fromEntries((body.tools ?? []).map((t) => [t.name, t.defer_loading === true]))
const findResultBlock = (body) =>
  body.messages
    .flatMap((m) => (m.role === "user" ? m.content : []))
    .find((b) => b.type === "tool_result" && b.content?.some((c) => c.type === "tool_reference"))
const secondReq = requests[1]?.body
const findUser = secondReq?.messages.find(
  (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
)

const expectedDeferred = {
  today: false,
  tool_find: false,
  get_weather: true,
  search_files: true,
  check_stock: true,
}
const checks = [
  ["能力位：deferredTools=true", caps.deferredTools === true, JSON.stringify(caps)],
  [
    "两次 run 都正常结束",
    first.result.status === "done" && second.result.status === "done",
    `${first.result.status} / ${second.result.status}`,
  ],
  [
    "每个请求 tools 都是全表且菜单工具 defer_loading、today / tool_find 不延迟",
    requests.every((r) => {
      const d = deferredOf(r.body)
      return (
        Object.keys(d).length === Object.keys(expectedDeferred).length &&
        Object.entries(expectedDeferred).every(([k, v]) => d[k] === v)
      )
    }),
    requests.map((r) => JSON.stringify(deferredOf(r.body))).join(" | "),
  ],
  [
    "断点不落在延迟工具上（落在最后一个非延迟工具上）",
    requests.every(
      (r) =>
        (r.body.tools ?? []).every((t) => !(t.defer_loading && t.cache_control)) &&
        (r.body.tools ?? []).some((t) => t.cache_control),
    ),
    requests
      .map((r) =>
        (r.body.tools ?? [])
          .filter((t) => t.cache_control)
          .map((t) => t.name)
          .join(","),
      )
      .join(" | "),
  ],
  [
    "第一次 run：先 tool_find(get_weather) 再 get_weather(Paris)，最终答案含 22",
    calls(first)[0]?.[0] === "tool_find" &&
      calls(first)[0]?.[1]?.names?.includes("get_weather") &&
      calls(first).some(([n, a]) => n === "get_weather" && /paris/i.test(JSON.stringify(a))) &&
      /22/.test(texts(first).at(-1) ?? ""),
    `${JSON.stringify(calls(first))} text=${JSON.stringify(texts(first).at(-1)?.slice(0, 80))}`,
  ],
  [
    "tool_find 的 tool_result 里是 tool_reference 块，说明文字作为 text 块排在这批 tool_result 之后",
    !!findResultBlock(secondReq ?? { messages: [] }) &&
      findUser?.content.findIndex((b) => b.type === "text") >
        findUser?.content.map((b) => b.type).lastIndexOf("tool_result"),
    JSON.stringify(
      findUser?.content.map((b) =>
        b.type === "tool_result"
          ? `tool_result[${b.content?.map((c) => c.type).join(",")}]`
          : `${b.type}:${(b.text ?? "").slice(0, 40)}`,
      ),
    ),
  ],
  [
    "取回后第一次 run 的第 2、3 个请求 cacheRead > 0（工具表整段不变，前缀缓存保住）",
    usages(1, firstRequestCount).length >= 2 &&
      usages(1, firstRequestCount).every((u) => (u.cacheRead ?? 0) > 0),
    JSON.stringify(usages(0, firstRequestCount)),
  ],
  [
    "第二次 run：直接调 get_weather(Tokyo) 不再 tool_find（已取回集合从时间线重建、厂商从历史展开引用），且 cacheRead > 0",
    calls(second).length >= 1 &&
      calls(second).every(([n]) => n !== "tool_find") &&
      calls(second).some(([n, a]) => n === "get_weather" && /tokyo/i.test(JSON.stringify(a))) &&
      usages(firstRequestCount).every((u) => (u.cacheRead ?? 0) > 0),
    `${JSON.stringify(calls(second))} usages=${JSON.stringify(usages(firstRequestCount))}`,
  ],
  [
    "有损落点只有声明过的（tool-reference lossy：说明文字改放之后；运维事件 dropped）",
    requests.every((r) =>
      r.losses.every(
        (l) =>
          (l.kind === "dropped" && (l.type === "core.budget_usage" || l.type === "core.tools_bound")) ||
          (l.kind === "lossy" && l.type === "core.tool_result" && l.landing === "tool-reference"),
      ),
    ),
    JSON.stringify([
      ...new Set(requests.flatMap((r) => r.losses.map((l) => `${l.type}:${l.kind}/${l.landing}`))),
    ]),
  ],
]
console.log(`\n=== L1 live: ${MODEL_ID} ===`)
let pass = 0
for (const [label, ok, detail] of checks) {
  pass += ok ? 1 : 0
  console.log(`${ok ? "✓" : "✗"} ${label}\n    ${detail}`)
}
console.log(`—— ${pass}/${checks.length}`)
