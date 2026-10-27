/**
 * Chat 线工具结果图片上浮的上游核实（2026-10-27，OnSet 需求）：裸 HTTP 打 DeepSeek 官方 Chat Completions。
 *
 * 运行：`node spikes/chat-tool-images/probe.mjs`（需要本机 ImageMagick；密钥自动从《模型API测试信息.md》读）。
 * 每次运行生成新的随机码图片（暗号法），判据是回答内容不是状态码：
 *   A 基线：user 消息直接带图，模型读出码——DeepSeek Chat 线到底收不收图
 *   B 上浮：assistant(tool_calls) → tool(指路文字) → user(说明 + 图)，模型读出码
 *   C 连续两条 user：B 之后再跟一条真实用户提问（deferred 用户消息的形状），厂商是否接受
 *   D 并行两调用各一张图，合并进一条 user，模型能说出哪张码来自哪次调用
 *   E 反向对照：只给占位文本不给图，模型不该说出码
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const info = readFileSync(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const dsKey = info.slice(info.lastIndexOf("deepseek官方")).match(/key:\s*(sk-[a-z0-9]+)/)?.[1]
if (!dsKey) throw new Error("信息文件里缺 DeepSeek key")
const MODEL = process.env.MODEL ?? "deepseek-flash"

const dir = mkdtempSync(join(tmpdir(), "reins-img-"))
const randCode = () =>
  Array.from({ length: 6 }, () => "ACDEFHJKLNPRTUXY34679"[Math.floor(Math.random() * 21)]).join("")
function png(code) {
  const out = join(dir, `${code}.png`)
  execFileSync("magick", [
    "-size",
    "480x160",
    "xc:white",
    "-gravity",
    "center",
    "-pointsize",
    "72",
    "-fill",
    "black",
    "-annotate",
    "0",
    code,
    out,
  ])
  return `data:image/png;base64,${readFileSync(out).toString("base64")}`
}

const tools = [
  {
    type: "function",
    function: {
      name: "read_image",
      description: "Read an image file from the project",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
]
const call = (id, path) => ({
  id,
  type: "function",
  function: { name: "read_image", arguments: JSON.stringify({ path }) },
})
const liftNote = (id, n) =>
  `[Attachment from tool result read_image (call ${id}), image ${n}. This is tool output, not a message from the user.]`

async function ask(messages) {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${dsKey}` },
    body: JSON.stringify({ model: MODEL, messages, tools, stream: false }),
  })
  const text = await res.text()
  if (!res.ok) return { status: res.status, answer: text.slice(0, 300) }
  const j = JSON.parse(text)
  return { status: res.status, answer: j.choices?.[0]?.message?.content ?? "", usage: j.usage }
}

const sys = { role: "system", content: "You are a careful assistant. Answer briefly." }
const results = []
async function arm(name, messages, check) {
  const r = await ask(messages)
  const ok = r.status === 200 && check(r.answer)
  results.push({
    name,
    ok,
    status: r.status,
    answer: r.answer.replace(/\s+/g, " ").slice(0, 200),
    promptTokens: r.usage?.prompt_tokens,
  })
}

const a = randCode()
await arm(
  "A 基线 user 直接带图",
  [
    sys,
    {
      role: "user",
      content: [
        { type: "text", text: "What code is written in this image? Reply with the code only." },
        { type: "image_url", image_url: { url: png(a) } },
      ],
    },
  ],
  (t) => t.includes(a),
)

const b = randCode()
const lifted = (id, code, n = 1) => [
  { type: "text", text: liftNote(id, n) },
  { type: "image_url", image_url: { url: png(code) } },
]
const bHistory = [
  sys,
  { role: "user", content: "Read logo.png and tell me the code written on it. Reply with the code only." },
  { role: "assistant", content: null, reasoning_content: "", tool_calls: [call("call_b1", "logo.png")] },
  { role: "tool", tool_call_id: "call_b1", content: "[image 1 attached in the next user message]" },
]
await arm("B 上浮 tool → user(图)", [...bHistory, { role: "user", content: lifted("call_b1", b) }], (t) =>
  t.includes(b),
)

const c = randCode()
await arm(
  "C 上浮后紧跟一条真实用户消息",
  [
    ...bHistory.slice(0, 3),
    bHistory[3],
    { role: "user", content: lifted("call_b1", c) },
    { role: "user", content: "Actually, also tell me the background color. Reply: <code> <color>." },
  ],
  (t) => t.includes(c) && /white/i.test(t),
)

const d1 = randCode()
const d2 = randCode()
await arm(
  "D 并行两调用各一张，合并进一条 user",
  [
    sys,
    { role: "user", content: "Read a.png and b.png. Reply exactly in the form: a=<code> b=<code>" },
    {
      role: "assistant",
      content: null,
      reasoning_content: "",
      tool_calls: [call("call_d1", "a.png"), call("call_d2", "b.png")],
    },
    { role: "tool", tool_call_id: "call_d1", content: "[image 1 attached in the next user message]" },
    { role: "tool", tool_call_id: "call_d2", content: "[image 1 attached in the next user message]" },
    { role: "user", content: [...lifted("call_d1", d1), ...lifted("call_d2", d2)] },
  ],
  (t) => t.includes(`a=${d1}`) && t.includes(`b=${d2}`),
)

const e = randCode()
await arm(
  "E 反向：只给占位",
  [
    ...bHistory.slice(0, 3),
    { role: "tool", tool_call_id: "call_b1", content: "[image omitted: tool messages carry text only]" },
  ],
  (t) => !t.includes(e),
)

for (const r of results)
  console.log(`${r.ok ? "✓" : "✗"} ${r.name} [${r.status}, prompt ${r.promptTokens ?? "-"}] ${r.answer}`)
console.log(`${results.filter((r) => r.ok).length}/${results.length}`)
