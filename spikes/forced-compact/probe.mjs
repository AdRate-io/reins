/**
 * 到阈值强制模型整理的上游核实（2026-10-30，OnSet 反馈建议 4 / OPT-261030-3）：裸 HTTP 打 DeepSeek 官方 Chat Completions。
 *
 * 运行：`node spikes/forced-compact/probe.mjs [轮数]`（缺省 3 轮；密钥自动从《模型API测试信息.md》读；MODEL 环境变量换型号）。
 * 前缀 P = 系统提示（带一次性盐）+ 一段做到一半的巡检对话（约 8k token，最后一条是工具结果，模型"正想接着干"）。
 * 每轮先发两次 P 暖缓存（W2 的命中即基线），再发各臂：
 *   A  追加：P + 末尾一条 system 说明"先 compact 再继续"，工具表不变、不强制 —— 前缀不变，看模型照不照做
 *   B  强制：P 原样 + tool_choice 指定 compact —— thinking 模式下厂商接不接受、强制本身伤不伤缓存
 *   Br 强制任一：P 原样 + tool_choice "required" —— 同上，退一步的强制
 *   C  收窄：P + 同一条说明，工具表只留 compact —— 换工具表伤不伤缓存（对照臂）
 * 判据是产出内容不是状态码：调没调 compact、入参是否合法（summary 非空、keep 是数组）、有没有夹带别的调用；
 * 缓存看 usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens。
 */
import { readFileSync } from "node:fs"
import { allTools, compactTool, judge, NOTE, prefix } from "./scenario.mjs"

const info = readFileSync(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const dsKey = info.slice(info.lastIndexOf("deepseek官方")).match(/key:\s*(sk-[a-z0-9]+)/)?.[1]
if (!dsKey) throw new Error("信息文件里缺 DeepSeek key")
const MODEL = process.env.MODEL ?? "deepseek-v4-flash"
const ROUNDS = Number(process.argv[2] ?? 3)

// ---- 请求 ----
async function ask(body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${dsKey}` },
      body: JSON.stringify({ model: MODEL, stream: false, max_tokens: 8192, ...body }),
    })
    const text = await res.text()
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)))
      continue
    }
    if (!res.ok) return { status: res.status, error: text.slice(0, 400) }
    const j = JSON.parse(text)
    const m = j.choices?.[0]?.message ?? {}
    return {
      status: res.status,
      finish: j.choices?.[0]?.finish_reason,
      calls: (m.tool_calls ?? []).map((c) => ({ name: c.function.name, args: c.function.arguments })),
      text: m.content ?? "",
      hit: j.usage?.prompt_cache_hit_tokens ?? 0,
      miss: j.usage?.prompt_cache_miss_tokens ?? 0,
      out: j.usage?.completion_tokens ?? 0,
    }
  }
}

const rows = []
const rate = (r) => (r.hit + r.miss > 0 ? `${((100 * r.hit) / (r.hit + r.miss)).toFixed(1)}%` : "-")
for (let round = 1; round <= ROUNDS; round++) {
  const salt = Math.floor(Math.random() * 1e9)
  const P = prefix(salt)
  const withNote = [...P, { role: "system", content: NOTE }]
  await ask({ messages: P, tools: allTools, max_tokens: 1 }) // 写缓存
  await new Promise((r) => setTimeout(r, 2000))
  const arms = [
    ["W2 基线（P 原样）", { messages: P, tools: allTools }],
    ["A 追加说明", { messages: withNote, tools: allTools }],
    [
      "B 强制 compact",
      { messages: P, tools: allTools, tool_choice: { type: "function", function: { name: "compact" } } },
    ],
    ["Br 强制 required", { messages: P, tools: allTools, tool_choice: "required" }],
    ["C 只留 compact", { messages: withNote, tools: [compactTool] }],
  ]
  for (const [name, body] of arms) {
    const r = await ask(body)
    const j = name.startsWith("W2")
      ? {
          verdict: r.status === 200 ? `(${r.calls[0]?.name ?? "正文"})` : `HTTP ${r.status}`,
          detail: r.error ?? "",
        }
      : judge(r)
    rows.push({
      round,
      arm: name,
      ...j,
      hit: r.hit,
      miss: r.miss,
      rate: rate(r),
      out: r.out,
      finish: r.finish,
    })
    console.log(
      `#${round} ${name.padEnd(16)} ${j.verdict.padEnd(22)} 命中 ${String(r.hit ?? "-").padStart(5)} / 未中 ${String(r.miss ?? "-").padStart(5)} (${rate(r)}) 输出 ${r.out ?? "-"} finish=${r.finish ?? "-"}  ${j.detail ?? ""}`,
    )
  }
}

// ---- 汇总 ----
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
