/**
 * forced-compact 的 Anthropic 官方对照（2026-10-30）：经 CF AI Gateway 透传路径打 Messages API，缺省 claude-haiku-5-5。
 *
 * 运行：`node spikes/forced-compact/probe-anthropic.mjs [轮数]`（缺省 3 轮；配置自动从《模型API测试信息.md》读；MODEL 环境变量换型号）。
 * 与 probe.mjs 同一段对话（scenario.mjs），换算成 Messages 形状：说明是末尾一条 role:"system"（中途 system，紧跟只带
 * tool_result 的 user）；缓存用顶层 `cache_control` 自动断点；thinking 不设（Haiku 5.5 缺省 adaptive），即真实用法。
 * 各臂同 probe.mjs：W2 基线 / A 追加说明 / B tool_choice 指定 compact / Br tool_choice any / C 只留 compact。
 * 缓存看 usage.cache_read_input_tokens 占 (read + creation + input) 的比例。
 */
import { readFileSync } from "node:fs"
import { allTools, compactTool, judge, NOTE, prefix } from "./scenario.mjs"

const info = readFileSync(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const token = info.match(/cfut_[A-Za-z0-9_-]+/)?.[0]
const account = info.match(/account id：\s*([0-9a-f]{32})/)?.[1]
if (!token || !account) throw new Error("信息文件里缺 CF 网关令牌或 account id")
const URL_ = `https://gateway.ai.cloudflare.com/v1/${account}/reins-dev/anthropic/v1/messages`
const MODEL = process.env.MODEL ?? "claude-haiku-5-5"
const ROUNDS = Number(process.argv[2] ?? 3)

// ---- Chat 形状 → Messages 形状 ----
const toolsOf = (tools) =>
  tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }))
function convert(chat) {
  const [sys, ...rest] = chat
  const messages = []
  for (const m of rest) {
    if (m.role === "user") messages.push({ role: "user", content: m.content })
    else if (m.role === "assistant")
      messages.push({
        role: "assistant",
        content: m.tool_calls.map((c) => ({
          type: "tool_use",
          id: c.id,
          name: c.function.name,
          input: JSON.parse(c.function.arguments),
        })),
      })
    else if (m.role === "tool")
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }],
      })
    else if (m.role === "system") messages.push({ role: "system", content: m.content })
  }
  return { system: sys.content, messages }
}

async function ask(body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(URL_, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "cf-aig-authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 8192, cache_control: { type: "ephemeral" }, ...body }),
    })
    const text = await res.text()
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)))
      continue
    }
    if (!res.ok) return { status: res.status, error: text.slice(0, 400) }
    const j = JSON.parse(text)
    const u = j.usage ?? {}
    const read = u.cache_read_input_tokens ?? 0
    return {
      status: res.status,
      finish: j.stop_reason,
      calls: (j.content ?? [])
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ name: b.name, args: JSON.stringify(b.input) })),
      text: (j.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(""),
      hit: read,
      miss: (u.cache_creation_input_tokens ?? 0) + (u.input_tokens ?? 0),
      out: u.output_tokens ?? 0,
    }
  }
}

const rows = []
const rate = (r) => (r.hit + r.miss > 0 ? `${((100 * r.hit) / (r.hit + r.miss)).toFixed(1)}%` : "-")
for (let round = 1; round <= ROUNDS; round++) {
  const salt = Math.floor(Math.random() * 1e9)
  const P = convert(prefix(salt))
  const withNote = { ...P, messages: [...P.messages, { role: "system", content: NOTE }] }
  const all = toolsOf(allTools)
  const warm = await ask({ ...P, tools: all, max_tokens: 0 }) // 写缓存
  if (warm.status !== 200) console.log(`#${round} 暖缓存失败 HTTP ${warm.status} ${warm.error}`)
  const arms = [
    ["W2 基线（P 原样）", { ...P, tools: all }],
    ["A 追加说明", { ...withNote, tools: all }],
    ["B 强制 compact", { ...P, tools: all, tool_choice: { type: "tool", name: "compact" } }],
    ["Br 强制 any", { ...P, tools: all, tool_choice: { type: "any" } }],
    ["C 只留 compact", { ...withNote, tools: toolsOf([compactTool]) }],
  ]
  for (const [name, body] of arms) {
    const r = await ask(body)
    const j = name.startsWith("W2")
      ? {
          verdict: r.status === 200 ? `(${r.calls[0]?.name ?? "正文"})` : `HTTP ${r.status}`,
          detail: r.error ?? "",
        }
      : judge(r)
    rows.push({ round, arm: name, ...j, hit: r.hit, miss: r.miss, out: r.out })
    console.log(
      `#${round} ${name.padEnd(16)} ${j.verdict.padEnd(22)} 命中 ${String(r.hit ?? "-").padStart(5)} / 未中 ${String(r.miss ?? "-").padStart(5)} (${rate(r)}) 输出 ${r.out ?? "-"} stop=${r.finish ?? "-"}  ${j.detail ?? ""}`,
    )
  }
}

console.log("\n== 汇总 ==")
for (const arm of [...new Set(rows.map((r) => r.arm))]) {
  const rs = rows.filter((r) => r.arm === arm)
  const complied = rs.filter((r) => r.complied).length
  const hit = rs.reduce((a, r) => a + (r.hit ?? 0), 0)
  const miss = rs.reduce((a, r) => a + (r.miss ?? 0), 0)
  const out = rs.reduce((a, r) => a + (r.out ?? 0), 0)
  console.log(
    `${arm.padEnd(16)} 照做 ${arm.startsWith("W2") ? "-" : `${complied}/${rs.length}`}  平均命中率 ${hit + miss ? ((100 * hit) / (hit + miss)).toFixed(1) : "-"}%  平均输出 ${Math.round(out / rs.length)} token`,
  )
}
