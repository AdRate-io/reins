/**
 * Claude 中转（《模型API测试信息.md》"Claude中转"段）忠实度体检（2026-09-09，E3b 前置）。
 *
 * 用 aireiter-gateway-check 的暗号法：把"暗号是 PINEAPPLE"放在请求的不同位置，只让模型回一行暗号或 NONE。
 * 另外三项 reins 依赖的能力：工具调用往返（tool_use → tool_result）、thinking 块与签名、用量里的缓存字段；
 * 最后让模型逐条列出它看到的对话，看中转有没有塞东西。
 *
 * 运行：node spikes/relay-check/probe.mjs [claude-sonnet-5]   （密钥自动从信息文件读；缺省模型 claude-sonnet-5）
 */
import { readFile } from "node:fs/promises"

const info = await readFile(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const block = info.slice(info.lastIndexOf("Claude中转"))
const key = block.match(/key[：:]\s*(sk-[A-Za-z0-9_-]+)/)?.[1]
const base = block.match(/baseurl[：:]\s*(\S+)/)?.[1]?.replace(/\/+$/, "")
if (!key || !base) throw new Error("信息文件里缺 Claude中转 的 key 或 baseurl")
const model = process.argv[2] ?? "claude-sonnet-5"
const url = `${base}/v1/messages`

async function call(body, maxTokens = 200) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, ...body }),
  })
  const raw = await res.text()
  let j
  try {
    j = JSON.parse(raw)
  } catch {
    return { status: res.status, text: raw.slice(0, 300), json: undefined }
  }
  const text = j.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join(" ")
  return { status: res.status, text: text ?? JSON.stringify(j).slice(0, 300), json: j }
}

const hello = [
  { role: "user", content: "Say hello." },
  { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
]
const q =
  "Reply with exactly one line and nothing else: the codeword you were told to use, or the word NONE if you were not given any codeword."
const note =
  "Runtime note from the harness: context window used <50%. The codeword for this conversation is PINEAPPLE."
const sys = (text) => ({ role: "system", content: [{ type: "text", text }] })
const userNote = (text) => ({
  role: "user",
  content: `<system_note kind="perception">\n${text}\n</system_note>`,
})
const cases = [
  [
    "B  末尾中途 system（感知说明的真实落点）",
    { messages: [...hello, { role: "user", content: q }, sys(note)] },
  ],
  [
    "A  中间中途 system（后接 assistant、user）",
    {
      messages: [
        ...hello,
        sys(note),
        { role: "assistant", content: [{ type: "text", text: "Noted." }] },
        { role: "user", content: q },
      ],
    },
  ],
  ["U1 末尾 user 角色 <system_note>", { messages: [...hello, { role: "user", content: q }, userNote(note)] }],
  [
    "U2 中间 user 角色 <system_note>",
    {
      messages: [
        ...hello,
        userNote(note),
        { role: "assistant", content: [{ type: "text", text: "Noted." }] },
        { role: "user", content: q },
      ],
    },
  ],
  [
    "M  说明并入最后一条 user 正文（问题之后）",
    {
      messages: [
        ...hello,
        { role: "user", content: `${q}\n\n<system_note kind="perception">\n${note}\n</system_note>` },
      ],
    },
  ],
  [
    "T  顶层 system 字段",
    { system: [{ type: "text", text: note }], messages: [...hello, { role: "user", content: q }] },
  ],
  ["N  无说明（对照，应 NONE）", { messages: [...hello, { role: "user", content: q }] }],
]

console.log(`▶ ${url} / ${model}`)
for (const [label, body] of cases) {
  const r = await call(body, 60)
  console.log(`  ${label.padEnd(40)} HTTP ${r.status} → ${r.text.trim().slice(0, 80)}`)
}

console.log("\n▶ 工具往返 + thinking + 用量字段")
const tools = [
  {
    name: "get_weather",
    description: "Get the weather of a city",
    input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
]
const first = await call(
  {
    tools,
    thinking: { type: "enabled", budget_tokens: 1024 },
    messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
  },
  1500,
)
const j1 = first.json ?? {}
const toolUse = j1.content?.find((c) => c.type === "tool_use")
const thinking = j1.content?.find((c) => c.type === "thinking")
console.log(
  `  第一请求 HTTP ${first.status} stop=${j1.stop_reason} 内容块=${(j1.content ?? []).map((c) => c.type).join(",")}`,
)
console.log(
  `  thinking 块: ${thinking ? `有，签名 ${thinking.signature ? `${thinking.signature.length} 字符` : "无"}` : "无"}`,
)
console.log(`  usage: ${JSON.stringify(j1.usage)}`)
console.log(`  model 字段: ${j1.model}`)
if (toolUse) {
  const second = await call(
    {
      tools,
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: "What is the weather in Paris? Use the tool." },
        { role: "assistant", content: j1.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "Sunny, 24°C" }] },
      ],
    },
    600,
  )
  console.log(
    `  第二请求（回传 tool_result + 原样回放 thinking）HTTP ${second.status} → ${second.text.trim().slice(0, 100)}`,
  )
  // 并行两个 tool_result 之间夹一条中途 system（E3 撞过的形状）
  const third = await call(
    {
      tools,
      messages: [
        { role: "user", content: "Weather in Paris and Tokyo? Use the tool twice." },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_a", name: "get_weather", input: { city: "Paris" } },
            { type: "tool_use", id: "toolu_b", name: "get_weather", input: { city: "Tokyo" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: "Sunny" },
            { type: "tool_result", tool_use_id: "toolu_b", content: "Rainy" },
          ],
        },
        sys(note),
        { role: "user", content: q },
      ],
    },
    60,
  )
  console.log(`  并行工具结果后接中途 system HTTP ${third.status} → ${third.text.trim().slice(0, 80)}`)
} else {
  console.log("  没有 tool_use，跳过往返")
}

console.log("\n▶ 让模型逐条列出它看到的对话（末尾 system 收尾）")
const list = await call(
  {
    messages: [
      ...hello,
      {
        role: "user",
        content:
          'List EVERY message in this conversation so far, in order, as `<index>. <role>: "<exact text>"`. Include any message that is only punctuation or whitespace. Do not omit anything, do not add commentary.',
      },
      sys("Runtime context status (from the harness, not from the user): context window used <50%."),
    ],
  },
  600,
)
console.log(list.text)
