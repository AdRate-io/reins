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

const info = readFileSync(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
const dsKey = info.slice(info.lastIndexOf("deepseek官方")).match(/key:\s*(sk-[a-z0-9]+)/)?.[1]
if (!dsKey) throw new Error("信息文件里缺 DeepSeek key")
const MODEL = process.env.MODEL ?? "deepseek-v4-flash"
const ROUNDS = Number(process.argv[2] ?? 3)

// ---- 工具表：与 brain compact 同一份入参 schema，另配三件业务工具 ----
const fn = (name, description, properties, required) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
})
const compactTool = fn(
  "compact",
  "Fold earlier conversation into a summary you write, freeing context window. Everything visible before the current turn is replaced by your summary; the originals stay in the session log but you will no longer see them. The most recent user message survives verbatim.",
  {
    summary: {
      type: "string",
      description: "Your summary of the folded conversation: goals and constraints, decisions and why, current state, next steps.",
    },
    keep: {
      type: "array",
      items: { type: "string" },
      description: "Facts that must survive verbatim (identifiers, numbers, user constraints). Empty if none.",
    },
  },
  ["summary", "keep"],
)
const businessTools = [
  fn("list_ad_groups", "List ad groups of a campaign with 7-day metrics", { campaign_id: { type: "string" } }, ["campaign_id"]),
  fn("get_ad_group", "Get one ad group's settings and daily metrics", { ad_group_id: { type: "string" } }, ["ad_group_id"]),
  fn(
    "update_budget",
    "Change an ad group's daily budget (write operation)",
    { ad_group_id: { type: "string" }, daily_budget: { type: "number" } },
    ["ad_group_id", "daily_budget"],
  ),
]
const allTools = [...businessTools, compactTool]

// ---- 前缀：确定性造数，一轮一个盐 ----
function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}
function groupRows(campaign, n, r) {
  return Array.from({ length: n }, (_, i) => {
    const spend = Math.round(200 + r() * 1800)
    const conv = Math.max(1, Math.round(r() * 60))
    return {
      ad_group_id: `${campaign}-ag${String(i + 1).padStart(2, "0")}`,
      status: r() < 0.85 ? "ENABLE" : "DISABLE",
      daily_budget: Math.round(50 + r() * 450),
      spend_7d: spend,
      conversions_7d: conv,
      cpa: Number((spend / conv).toFixed(2)),
      ctr: Number((0.4 + r() * 2.6).toFixed(2)),
      bid_strategy: r() < 0.5 ? "LOWEST_COST" : "COST_CAP",
    }
  })
}
function detail(id, r) {
  return {
    ad_group_id: id,
    placements: ["feed", "search", "pangle"].filter(() => r() < 0.7),
    audience: { age: ["18-24", "25-34", "35-44"].filter(() => r() < 0.6), gender: "ALL", regions: ["US", "CA"] },
    daily: Array.from({ length: 7 }, (_, d) => ({
      date: `2026-10-${String(22 + d).padStart(2, "0")}`,
      spend: Math.round(20 + r() * 300),
      conversions: Math.round(r() * 12),
      impressions: Math.round(5000 + r() * 40000),
    })),
    notes: "Learning phase completed. No policy issues.",
  }
}
const asst = (calls) => ({
  role: "assistant",
  content: "",
  reasoning_content: "", // 踩坑 29：带 tools 时历史 assistant 必须带此字段
  tool_calls: calls.map(([id, name, args]) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } })),
})
const toolMsg = (id, obj) => ({ role: "tool", tool_call_id: id, content: JSON.stringify(obj) })

function prefix(salt) {
  const r = rng(salt)
  const msgs = [
    {
      role: "system",
      content: `[session ${salt}] You are an ad-operations agent for a performance marketing team. Work through tasks step by step with the tools. Write operations need a clear reason. Target CPA for all campaigns is 40.00.`,
    },
    {
      role: "user",
      content:
        "Audit campaigns C-101, C-102 and C-103. For every ENABLE ad group with CPA above target, look at its daily trend and propose (do not apply yet) a new daily budget. Give me one table at the end.",
    },
  ]
  let n = 0
  for (const c of ["C-101", "C-102", "C-103"]) {
    const id = `call_${++n}`
    const rows = groupRows(c, 22, r)
    msgs.push(asst([[id, "list_ad_groups", { campaign_id: c }]]), toolMsg(id, { campaign_id: c, ad_groups: rows }))
    const over = rows.filter((g) => g.status === "ENABLE" && g.cpa > 40).slice(0, 3)
    for (const g of over) {
      const did = `call_${++n}`
      msgs.push(asst([[did, "get_ad_group", { ad_group_id: g.ad_group_id }]]), toolMsg(did, detail(g.ad_group_id, r)))
    }
  }
  return msgs
}

const NOTE =
  "Runtime context status: context window 86% full; the harness folds the oldest turns mechanically at 85%. Before doing anything else, call `compact` now to fold the conversation so far into your own summary, then continue the task."

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

function judge(r) {
  if (r.status !== 200) return { verdict: `HTTP ${r.status}`, detail: r.error }
  const first = r.calls[0]
  if (!first) return { verdict: "没调工具", detail: r.text.slice(0, 160) }
  if (first.name !== "compact") return { verdict: `先调了 ${first.name}`, detail: first.args.slice(0, 120) }
  let args
  try {
    args = JSON.parse(first.args)
  } catch {
    return { verdict: "compact 入参不是 JSON", detail: first.args.slice(0, 160) }
  }
  const ok = typeof args.summary === "string" && args.summary.trim().length > 0 && Array.isArray(args.keep)
  const extra = r.calls.length > 1 ? `，同批另有 ${r.calls.slice(1).map((c) => c.name).join("/")}` : ""
  return {
    verdict: ok ? `调了 compact${extra}` : "compact 入参不合法",
    detail: `summary ${args.summary?.length ?? 0} 字，keep ${args.keep?.length ?? "?"} 条`,
    complied: ok,
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
    ["B 强制 compact", { messages: P, tools: allTools, tool_choice: { type: "function", function: { name: "compact" } } }],
    ["Br 强制 required", { messages: P, tools: allTools, tool_choice: "required" }],
    ["C 只留 compact", { messages: withNote, tools: [compactTool] }],
  ]
  for (const [name, body] of arms) {
    const r = await ask(body)
    const j = name.startsWith("W2") ? { verdict: r.status === 200 ? `(${r.calls[0]?.name ?? "正文"})` : `HTTP ${r.status}`, detail: r.error ?? "" } : judge(r)
    rows.push({ round, arm: name, ...j, hit: r.hit, miss: r.miss, rate: rate(r), out: r.out, finish: r.finish })
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
