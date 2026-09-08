/**
 * aireiter 网关 Claude 端点对"中途 system / 末尾说明"的处置核实（2026-09-08，B2 附带）。
 *
 * 起因：B2 真模型实测里模型两次在 thinking 里说"用户只发了一个句号"，我们发出的请求里没有这条消息。
 * 方法：暗号法。把一句"暗号是 PINEAPPLE"放在不同位置，只让模型回一行"暗号或 NONE"——内容到了模型就答得出，
 * 不必让它复述系统提示（复述会触发拒答或撞 max_tokens）。另用"逐条列出所有消息"看网关实际交给模型的对话。
 * 对照：DeepSeek 官方 Anthropic 端口（直连、不经网关）。
 *
 * 运行：node spikes/aireiter-gateway-check/probe.mjs   （密钥自动从《模型API测试信息.md》读）
 */
import { readFile } from "node:fs/promises"

const info = await readFile(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const gwKey = info.match(/密钥（三种协议共用）：`(sk-[^`]+)`/)?.[1]
const dsBlock = info.slice(info.lastIndexOf("deepseek官方"))
const dsKey = dsBlock.match(/key:\s*(sk-[A-Za-z0-9_-]+)/)?.[1]
const dsBase = dsBlock.match(/anthropic 协议 baseurl：\s*(\S+)/)?.[1]
if (!gwKey || !dsKey || !dsBase) throw new Error("信息文件里缺密钥或 baseurl")

const targets = {
  aireiter: { url: "https://aireiter.com/api/v1/messages", key: gwKey, model: "claude-opus-5" },
  deepseek: { url: `${dsBase}/v1/messages`, key: dsKey, model: "deepseek-v4-flash" },
}
async function call(target, body, maxTokens) {
  const t = targets[target]
  const res = await fetch(t.url, {
    method: "POST",
    headers: { "x-api-key": t.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: t.model, max_tokens: maxTokens, ...body }),
  })
  const j = await res.json()
  const text = j.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join(" ")
  return { status: res.status, text: text ?? JSON.stringify(j).slice(0, 300) }
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
  [
    "U1 末尾 user 角色 <system_note>（降级层的有损兜底落点）",
    { messages: [...hello, { role: "user", content: q }, userNote(note)] },
  ],
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
    "M  说明并入最后一条 user 消息正文",
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

for (const target of ["aireiter", "deepseek"]) {
  console.log(`\n▶ ${target} / ${targets[target].model}`)
  for (const [label, body] of cases) {
    const r = await call(target, body, target === "deepseek" ? 2000 : 60)
    console.log(`  ${label.padEnd(44)} HTTP ${r.status} → ${r.text.trim().slice(0, 80)}`)
  }
}

console.log("\n▶ aireiter：让模型逐条列出它看到的对话（末尾 system 收尾）")
const list = await call(
  "aireiter",
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
