/**
 * forced-compact 两个探针共用的场景：工具表（Chat 形状，与 brain compact 同一份入参 schema）、确定性造数的前缀、
 * 末尾说明与判分。Anthropic 版把 Chat 形状换算成 Messages 形状，保证两家看到的是同一段对话。
 */
// ---- 工具表：与 brain compact 同一份入参 schema，另配三件业务工具 ----
const fn = (name, description, properties, required) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
  },
})
export const compactTool = fn(
  "compact",
  "Fold earlier conversation into a summary you write, freeing context window. Everything visible before the current turn is replaced by your summary; the originals stay in the session log but you will no longer see them. The most recent user message survives verbatim.",
  {
    summary: {
      type: "string",
      description:
        "Your summary of the folded conversation: goals and constraints, decisions and why, current state, next steps.",
    },
    keep: {
      type: "array",
      items: { type: "string" },
      description:
        "Facts that must survive verbatim (identifiers, numbers, user constraints). Empty if none.",
    },
  },
  ["summary", "keep"],
)
const businessTools = [
  fn(
    "list_ad_groups",
    "List ad groups of a campaign with 7-day metrics",
    { campaign_id: { type: "string" } },
    ["campaign_id"],
  ),
  fn("get_ad_group", "Get one ad group's settings and daily metrics", { ad_group_id: { type: "string" } }, [
    "ad_group_id",
  ]),
  fn(
    "update_budget",
    "Change an ad group's daily budget (write operation)",
    { ad_group_id: { type: "string" }, daily_budget: { type: "number" } },
    ["ad_group_id", "daily_budget"],
  ),
]
export const allTools = [...businessTools, compactTool]

// ---- 前缀：确定性造数，一轮一个盐 ----
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
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
    audience: {
      age: ["18-24", "25-34", "35-44"].filter(() => r() < 0.6),
      gender: "ALL",
      regions: ["US", "CA"],
    },
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
  tool_calls: calls.map(([id, name, args]) => ({
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  })),
})
const toolMsg = (id, obj) => ({ role: "tool", tool_call_id: id, content: JSON.stringify(obj) })

export function prefix(salt) {
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
    msgs.push(
      asst([[id, "list_ad_groups", { campaign_id: c }]]),
      toolMsg(id, { campaign_id: c, ad_groups: rows }),
    )
    const over = rows.filter((g) => g.status === "ENABLE" && g.cpa > 40).slice(0, 3)
    for (const g of over) {
      const did = `call_${++n}`
      msgs.push(
        asst([[did, "get_ad_group", { ad_group_id: g.ad_group_id }]]),
        toolMsg(did, detail(g.ad_group_id, r)),
      )
    }
  }
  return msgs
}

export const NOTE =
  "Runtime context status: context window 86% full; the harness folds the oldest turns mechanically at 85%. Before doing anything else, call `compact` now to fold the conversation so far into your own summary, then continue the task."

export function judge(r) {
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
  const extra =
    r.calls.length > 1
      ? `，同批另有 ${r.calls
          .slice(1)
          .map((c) => c.name)
          .join("/")}`
      : ""
  return {
    verdict: ok ? `调了 compact${extra}` : "compact 入参不合法",
    detail: `summary ${args.summary?.length ?? 0} 字，keep ${args.keep?.length ?? "?"} 条`,
    complied: ok,
  }
}
