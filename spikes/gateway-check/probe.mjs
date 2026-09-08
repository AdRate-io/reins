/**
 * 网关协议探针：核对 aireiter.com 的三种协议是否与官方行为一致，只测 reins 真正依赖的特性。
 * 用法：node probe.mjs <messages|chat|responses>   密钥从仓库根 模型API测试信息.md 读取，不打印。
 * 每个请求的原始响应落在 out/ 下便于回看（已 gitignore）。
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const KEY = readFileSync(join(here, "../../模型API测试信息.md"), "utf8").match(/sk-[A-Za-z0-9_-]+/)[0]
const BASE = "https://aireiter.com/api/v1"
const which = process.argv[2]

const TOOL_DESC = "查询城市当前天气"
const SCHEMA = { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
const results = []
const ok = (name, pass, note = "") => {
  results.push({ name, pass, note })
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${note ? `  —  ${note}` : ""}`)
}

/** 带重试的请求；返回 { status, text, events(SSE 解析) } */
async function call(path, body, headers, label) {
  let last
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    last = { status: res.status, text, ct: res.headers.get("content-type") ?? "" }
    if (res.status !== 502 && res.status !== 503 && res.status !== 504) break
    console.log(`  (第 ${attempt} 次 ${res.status}，重试)`)
    await new Promise((r) => setTimeout(r, 1500 * attempt))
  }
  writeFileSync(join(here, "out", `${label}.txt`), `HTTP ${last.status} ${last.ct}\n\n${last.text}`)
  const events = []
  if (last.ct.includes("event-stream")) {
    for (const chunk of last.text.split(/\n\n+/)) {
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("")
      if (!data || data === "[DONE]") continue
      try {
        events.push(JSON.parse(data))
      } catch {
        events.push({ _unparsed: data.slice(0, 120) })
      }
    }
  }
  return { ...last, events, json: safeJson(last.text) }
}
function safeJson(t) {
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}
const uniq = (arr) => [...new Set(arr)]

// ------------------------------------------------------------ Anthropic Messages
async function messages() {
  const H = { "x-api-key": KEY, "anthropic-version": "2023-06-01" }
  const tools = [{ name: "get_weather", description: TOOL_DESC, input_schema: SCHEMA }]
  const model = "claude-sonnet-4-5-20250929"

  // M1 流式 + thinking + 工具
  const r1 = await call(
    "/messages",
    {
      model,
      max_tokens: 2048,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 1024 },
      tools,
      system: "你是天气助手，必须先调用 get_weather 再回答。",
      messages: [{ role: "user", content: "上海现在天气怎么样？" }],
    },
    H,
    "messages-m1-stream",
  )
  const types = uniq(r1.events.map((e) => e.type))
  ok("M1 流式返回 SSE", r1.status === 200 && r1.ct.includes("event-stream"), `HTTP ${r1.status} ${r1.ct}`)
  ok(
    "M1 事件序列含 message_start/content_block_*/message_delta/message_stop",
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ].every((t) => types.includes(t)),
    types.join(","),
  )
  const starts = r1.events.filter((e) => e.type === "content_block_start").map((e) => e.content_block?.type)
  ok("M1 出现 thinking 块", starts.includes("thinking"), `blocks: ${starts.join(",")}`)
  const sig = r1.events.find((e) => e.type === "content_block_delta" && e.delta?.type === "signature_delta")
    ?.delta?.signature
  ok("M1 thinking 带 signature_delta", Boolean(sig), sig ? `签名 ${sig.length} 字符` : "无")
  const toolStart = r1.events.find(
    (e) => e.type === "content_block_start" && e.content_block?.type === "tool_use",
  )
  const argJson = r1.events
    .filter((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta")
    .map((e) => e.delta.partial_json)
    .join("")
  ok(
    "M1 出现 tool_use 且 input_json_delta 可拼成 JSON",
    Boolean(toolStart) && Boolean(safeJson(argJson)),
    argJson.slice(0, 80),
  )
  const md = r1.events.find((e) => e.type === "message_delta")
  ok(
    "M1 message_delta 带 stop_reason=tool_use 与 usage.output_tokens",
    md?.delta?.stop_reason === "tool_use" && typeof md?.usage?.output_tokens === "number",
    JSON.stringify({ stop: md?.delta?.stop_reason, usage: md?.usage }),
  )
  const ms = r1.events.find((e) => e.type === "message_start")
  ok(
    "M1 message_start 带 usage.input_tokens",
    typeof ms?.message?.usage?.input_tokens === "number",
    JSON.stringify(ms?.message?.usage),
  )

  // M2 第二轮：回放 thinking(签名) + tool_use + tool_result
  if (toolStart && sig) {
    const thinkingText = r1.events
      .filter((e) => e.type === "content_block_delta" && e.delta?.type === "thinking_delta")
      .map((e) => e.delta.thinking)
      .join("")
    const r2 = await call(
      "/messages",
      {
        model,
        max_tokens: 1024,
        thinking: { type: "enabled", budget_tokens: 1024 },
        tools,
        system: "你是天气助手，必须先调用 get_weather 再回答。",
        messages: [
          { role: "user", content: "上海现在天气怎么样？" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: thinkingText, signature: sig },
              {
                type: "tool_use",
                id: toolStart.content_block.id,
                name: "get_weather",
                input: safeJson(argJson) ?? {},
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: toolStart.content_block.id, content: "晴，28℃" }],
          },
        ],
      },
      H,
      "messages-m2-replay",
    )
    ok(
      "M2 回放签名 thinking + 工具结果被接受",
      r2.status === 200 && r2.json?.stop_reason,
      `HTTP ${r2.status} ${r2.status !== 200 ? r2.text.slice(0, 200) : `stop=${r2.json.stop_reason}`}`,
    )
    // 篡改签名应被拒（证明签名在网关后真的被校验）
    const r2b = await call(
      "/messages",
      {
        model,
        max_tokens: 256,
        thinking: { type: "enabled", budget_tokens: 1024 },
        tools,
        messages: [
          { role: "user", content: "上海现在天气怎么样？" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: thinkingText, signature: "bad-signature" },
              {
                type: "tool_use",
                id: toolStart.content_block.id,
                name: "get_weather",
                input: safeJson(argJson) ?? {},
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: toolStart.content_block.id, content: "晴" }],
          },
        ],
      },
      H,
      "messages-m2b-badsig",
    )
    ok(
      "M2b 伪造签名被拒（说明签名真被校验，不是网关吞掉）",
      r2b.status === 400,
      `HTTP ${r2b.status} ${r2b.text.slice(0, 120)}`,
    )
  }

  // M3 中途 system：Opus 5 应接受；Sonnet 4.5 应 400
  for (const [m, expect] of [
    ["claude-opus-5", 200],
    ["claude-sonnet-4-5-20250929", 400],
  ]) {
    const r3 = await call(
      "/messages",
      {
        model: m,
        max_tokens: 64,
        system: "你是代码评审员。",
        messages: [
          { role: "user", content: "请评审这个函数。" },
          { role: "assistant", content: [{ type: "text", text: "看起来没问题。" }] },
          { role: "user", content: "再看一遍，只回一个词。" },
          { role: "system", content: [{ type: "text", text: "从现在起所有回答必须以「评审：」开头。" }] },
        ],
      },
      H,
      `messages-m3-midsystem-${m}`,
    )
    const body = r3.json?.content?.map((c) => c.text).join("") ?? r3.text.slice(0, 160)
    ok(
      `M3 中途 system @ ${m} 期望 HTTP ${expect}`,
      r3.status === expect,
      `HTTP ${r3.status} ${body.slice(0, 100)}`,
    )
  }

  // M4 Claude 走 chat/completions 是否也通（网关转换能力，参考项）
  const r4 = await call(
    "/chat/completions",
    { model, max_tokens: 32, messages: [{ role: "user", content: "只回一个词：好" }] },
    { authorization: `Bearer ${KEY}` },
    "messages-m4-claude-via-chat",
  )
  ok(
    "M4（参考）Claude 经 chat/completions 也可用",
    r4.status === 200,
    `HTTP ${r4.status} ${(r4.json?.choices?.[0]?.message?.content ?? r4.text).slice(0, 80)}`,
  )
}

// ------------------------------------------------------------ OpenAI Chat Completions
async function chat() {
  const H = { authorization: `Bearer ${KEY}` }
  const tools = [
    { type: "function", function: { name: "get_weather", description: TOOL_DESC, parameters: SCHEMA } },
  ]
  const model = process.env.MODEL ?? "gpt-5.5"

  const r1 = await call(
    "/chat/completions",
    {
      model,
      stream: true,
      stream_options: { include_usage: true },
      tools,
      messages: [
        { role: "system", content: "你是天气助手，必须先调用 get_weather 再回答。" },
        { role: "user", content: "上海现在天气怎么样？" },
      ],
    },
    H,
    "chat-c1-stream",
  )
  ok(
    "C1 流式返回 SSE",
    r1.status === 200 && r1.ct.includes("event-stream"),
    `HTTP ${r1.status} ${r1.ct} ${r1.status !== 200 ? r1.text.slice(0, 160) : ""}`,
  )
  const chunks = r1.events.filter((e) => e.object === "chat.completion.chunk")
  ok("C1 chunk.object=chat.completion.chunk", chunks.length > 0, `${chunks.length} 个 chunk`)
  const tc = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
  const first = tc.find((t) => t.id)
  const args = tc.map((t) => t.function?.arguments ?? "").join("")
  ok(
    "C1 delta.tool_calls 带 id/name，arguments 分片可拼成 JSON",
    Boolean(first?.id && first?.function?.name) && Boolean(safeJson(args)),
    `${first?.function?.name} ${args.slice(0, 60)}`,
  )
  const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).find(Boolean)
  ok("C1 finish_reason=tool_calls", finish === "tool_calls", String(finish))
  const usage = chunks.find((c) => c.usage)?.usage
  ok(
    "C1 include_usage 生效（末尾 usage chunk）",
    typeof usage?.prompt_tokens === "number",
    JSON.stringify(usage),
  )

  if (first) {
    const r2 = await call(
      "/chat/completions",
      {
        model,
        tools,
        messages: [
          { role: "system", content: "你是天气助手。" },
          { role: "user", content: "上海现在天气怎么样？" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: first.id, type: "function", function: { name: "get_weather", arguments: args } },
            ],
          },
          { role: "tool", tool_call_id: first.id, content: "晴，28℃" },
        ],
      },
      H,
      "chat-c2-toolresult",
    )
    ok(
      "C2 回传 tool 角色结果后正常作答",
      r2.status === 200 && Boolean(r2.json?.choices?.[0]?.message?.content),
      `HTTP ${r2.status} ${(r2.json?.choices?.[0]?.message?.content ?? r2.text).slice(0, 80)}`,
    )
  }
  // C3 reasoning 模型在 chat 协议下 usage 是否报 reasoning_tokens（参考）
  const r3 = await call(
    "/chat/completions",
    { model, messages: [{ role: "user", content: "只回一个词：好" }] },
    H,
    "chat-c3-usage",
  )
  ok(
    "C3（参考）非流式 usage 字段",
    typeof r3.json?.usage?.completion_tokens === "number",
    JSON.stringify(r3.json?.usage),
  )
}

// ------------------------------------------------------------ OpenAI Responses
async function responses() {
  const H = { authorization: `Bearer ${KEY}` }
  const tools = [
    { type: "function", name: "get_weather", description: TOOL_DESC, parameters: SCHEMA, strict: false },
  ]
  const model = process.env.MODEL ?? "gpt-5.5"

  const r1 = await call(
    "/responses",
    {
      model,
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "low", summary: "auto" },
      tools,
      input: [
        {
          role: "developer",
          content: [{ type: "input_text", text: "你是天气助手，必须先调用 get_weather 再回答。" }],
        },
        { role: "user", content: [{ type: "input_text", text: "上海现在天气怎么样？" }] },
      ],
    },
    H,
    "responses-r1-stream",
  )
  ok(
    "R1 流式返回 SSE",
    r1.status === 200 && r1.ct.includes("event-stream"),
    `HTTP ${r1.status} ${r1.ct} ${r1.status !== 200 ? r1.text.slice(0, 160) : ""}`,
  )
  const types = uniq(r1.events.map((e) => e.type))
  ok(
    "R1 事件序列含 response.created / output_item.added / output_item.done / response.completed",
    [
      "response.created",
      "response.output_item.added",
      "response.output_item.done",
      "response.completed",
    ].every((t) => types.includes(t)),
    types.join(","),
  )
  const done = r1.events.filter((e) => e.type === "response.output_item.done").map((e) => e.item)
  const reasoning = done.find((i) => i.type === "reasoning")
  ok(
    "R1 有 reasoning item 且带 encrypted_content",
    Boolean(reasoning?.encrypted_content),
    reasoning
      ? `id=${reasoning.id} enc=${String(reasoning.encrypted_content ?? "").length} 字符`
      : "无 reasoning item",
  )
  const fc = done.find((i) => i.type === "function_call")
  ok(
    "R1 有 function_call item（call_id / id / arguments）",
    Boolean(fc?.call_id && fc?.name) && Boolean(safeJson(fc?.arguments ?? "")),
    fc ? `${fc.name} call_id=${fc.call_id} id=${fc.id} ${fc.arguments}` : "无",
  )
  ok(
    "R1 有 function_call_arguments.delta 增量事件",
    types.includes("response.function_call_arguments.delta"),
    "",
  )
  const completed = r1.events.find((e) => e.type === "response.completed")?.response
  ok(
    "R1 response.completed 带 usage（含 reasoning_tokens）",
    typeof completed?.usage?.input_tokens === "number",
    JSON.stringify(completed?.usage),
  )
  ok("R1 completed.status=completed", completed?.status === "completed", String(completed?.status))

  if (fc) {
    const input = [
      { role: "developer", content: [{ type: "input_text", text: "你是天气助手。" }] },
      { role: "user", content: [{ type: "input_text", text: "上海现在天气怎么样？" }] },
    ]
    if (reasoning) input.push(reasoning)
    input.push({
      type: "function_call",
      id: fc.id,
      call_id: fc.call_id,
      name: fc.name,
      arguments: fc.arguments,
    })
    input.push({ type: "function_call_output", call_id: fc.call_id, output: "晴，28℃" })
    input.push({ role: "developer", content: [{ type: "input_text", text: "回答必须以「播报：」开头。" }] })
    const r2 = await call(
      "/responses",
      {
        model,
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "low" },
        tools,
        input,
      },
      H,
      "responses-r2-replay",
    )
    const text =
      r2.json?.output
        ?.filter((o) => o.type === "message")
        .flatMap((o) => o.content)
        .map((c) => c.text)
        .join("") ?? r2.text.slice(0, 160)
    ok(
      "R2 回放 reasoning(encrypted) + function_call/output + 中途 developer 被接受",
      r2.status === 200 && r2.json?.status === "completed",
      `HTTP ${r2.status} ${text.slice(0, 100)}`,
    )
    if (reasoning) {
      const bad = { ...reasoning, encrypted_content: "gAAAA-tampered" }
      const r2b = await call(
        "/responses",
        { model, store: false, tools, input: [input[0], input[1], bad, ...input.slice(3)] },
        H,
        "responses-r2b-badenc",
      )
      ok(
        "R2b 伪造 encrypted_content 被拒（说明真被校验）",
        r2b.status === 400,
        `HTTP ${r2b.status} ${r2b.text.slice(0, 120)}`,
      )
    }
  }
  // R3 字符串 input（Boss 给的示例形态）
  const r3 = await call(
    "/responses",
    { model, store: false, input: "只回一个词：好" },
    H,
    "responses-r3-string-input",
  )
  ok(
    "R3 字符串 input 非流式",
    r3.status === 200 && r3.json?.status === "completed",
    `HTTP ${r3.status} ${r3.text.slice(0, 80)}`,
  )
}

const run = { messages, chat, responses }[which]
if (!run) {
  console.error("用法：node probe.mjs <messages|chat|responses>")
  process.exit(2)
}
console.log(`=== ${which} ===`)
await run()
const fails = results.filter((r) => !r.pass).length
console.log(`\n${which}: ${results.length - fails}/${results.length} 通过`)
