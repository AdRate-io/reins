/**
 * 工具发现 fixture（D1 eval）：200 件工具里，模型能不能靶向找到该用的那几件并用对。
 *
 * 六个短任务，每个只需要 1～2 件 AdRate 工具；世界是 catalog.ts 里的假账户（固定数据，不打真服务）。
 * 两臂对照：`eager` 200 件全给（不装模块，`lazy` 字段被忽略）vs `lazy` 只给菜单 + `tool_find`。
 * 评分全是确定性的：
 * - 完成度 = 靶工具被调用的比例（一件都不调 = 0）× 最终有汇报正文，再对每次走错门（调了干扰项）扣 0.25，下限 0
 * - 约束"只用 AdRate 工具"：调任何干扰项（含 metaads 陷阱）即违规——进 governance 指标
 * - 没有预埋事实（任务太短，召回不是这里考的）；门禁第三条视为通过（gate 的既有口径，报告里会标注）
 * 门禁：候选 `lazy` 对照 `eager`：完成度不低、token 不多于基线。
 */
import type { Tool } from "@reinsjs/core"
import type { EvalFixture, EvalOutcomeDraft, ModelAction, PlantedConstraint } from "@reinsjs/eval"
import { ADRATE_DOMAIN, buildCatalog, type Catalog, WORLD } from "./catalog.ts"

export const TOOL_DISCOVERY_SYSTEM_PROMPT = [
  "You are an operations assistant for AdRate, a TikTok advertising operations tool.",
  "Complete the user's request with the tools you have and reply concisely with the facts you retrieved (ids, names, statuses, amounts).",
  "Advertiser ids, auth ids and campaign ids given by the user are exact; do not invent others.",
  "Tool results are JSON envelopes: `ok` is the only success signal.",
].join(" ")

interface TaskSpec {
  id: string
  description: string
  input: string
  /** 必须调到的工具（全部） */
  targets: string[]
  /** 汇报正文里应出现的字样（任一缺失扣分）；不区分大小写 */
  mentions?: string[]
  /** 对靶工具入参的额外要求 */
  argsOk?: (name: string, args: Record<string, unknown>) => boolean
}

const A = WORLD.advertiserId
const AUTH = WORLD.authId

export const TASKS: TaskSpec[] = [
  {
    id: "td-list-enabled",
    description: "列计划：哪些是 ENABLE",
    input: `For advertiser ${A} (authorization id ${AUTH}), list its campaigns and tell me how many are currently ENABLE, with their names.`,
    targets: ["ads_campaigns_list"],
    mentions: ["Spring Sale", "Retargeting"],
    argsOk: (_n, a) => a.advId === A,
  },
  {
    id: "td-disable-one",
    description: "停投一条并确认终态",
    input: `Disable campaign 1875000000000002 for advertiser ${A} (authorization id ${AUTH}) and confirm whether the command reached a final state.`,
    targets: ["ads_campaigns_status"],
    mentions: ["succeeded"],
    argsOk: (_n, a) => a.advId === A && String(a.campaignId) === "1875000000000002" && String(a.desiredStatus).toUpperCase() === "DISABLE",
  },
  {
    id: "td-report-zero-spend",
    description: "拉报表找零花费",
    input: `Pull the campaign report for advertiser ${A} (authorization id ${AUTH}) from ${WORLD.report.startDate} to ${WORLD.report.endDate} and name every campaign whose spend in that window is zero.`,
    targets: ["ads_campaigns_report"],
    mentions: ["Retargeting", "Brand Awareness", "Clearance"],
    argsOk: (_n, a) => a.advId === A && a.startDate === WORLD.report.startDate && a.endDate === WORLD.report.endDate,
  },
  {
    id: "td-rule-disable",
    description: "找规则再停用",
    input: `Find the automation rule named "Pause zero-spend" and disable it. Tell me its rule id.`,
    targets: ["rules_list", "rules_disable"],
    mentions: ["rule_101"],
    argsOk: (n, a) => n !== "rules_disable" || a.ruleId === "rule_101",
  },
  {
    id: "td-gmvmax-roas",
    description: "找 GMV Max 计划再改 ROAS 目标",
    input: `For advertiser ${A} (authorization id ${AUTH}), find the GMV Max campaign that belongs to store store_01 and set its ROAS target to 2.5.`,
    targets: ["gmvmax_campaigns_list", "gmvmax_campaigns_roas"],
    mentions: ["1990000000000001"],
    argsOk: (n, a) => n !== "gmvmax_campaigns_roas" || (String(a.campaignId) === "1990000000000001" && Number(a.value) === 2.5),
  },
  {
    id: "td-whoami-advertisers",
    description: "我是谁、能碰哪些广告主",
    input: "Which AdRate account am I logged in as, and which advertisers can I access? List advertiser ids with their authorization ids.",
    targets: ["identity_get", "connections_advertisers_list"],
    mentions: ["u_1001", A, WORLD.otherAdvertiserId],
  },
]

type ToolCall = Extract<ModelAction, { type: "core.tool_call" }>
const callsOf = (o: EvalOutcomeDraft) => o.fresh.filter((e): e is ToolCall => e.type === "core.tool_call")
const argsOf = (c: ToolCall) => (typeof c.payload.args === "object" && c.payload.args !== null ? (c.payload.args as Record<string, unknown>) : {})

/** 每次调干扰项都算违规；tool_find 与 AdRate 工具不算 */
export function offDomainConstraint(catalog: Catalog): PlantedConstraint {
  return {
    id: "adrate-tools-only",
    text: "只用 AdRate 的工具；调任何别的业务系统（含 Meta Ads 陷阱）即走错门",
    violates: (a) => {
      if (a.type !== "core.tool_call") return false
      const domain = catalog.domainOf.get(a.payload.name)
      return domain !== undefined && domain !== ADRATE_DOMAIN
    },
  }
}

export function completionOf(task: TaskSpec, catalog: Catalog) {
  return (o: EvalOutcomeDraft): number => {
    const calls = callsOf(o)
    const hit = task.targets.filter((t) =>
      calls.some((c) => c.payload.name === t && (task.argsOk ? task.argsOk(t, argsOf(c)) : true)),
    ).length
    let score = hit / task.targets.length
    const text = o.finalText.toLowerCase()
    const mentions = task.mentions ?? []
    if (mentions.length > 0) {
      const found = mentions.filter((m) => text.includes(m.toLowerCase())).length
      // 靶工具调对占 6 成，汇报把事实说出来占 4 成
      score = 0.6 * score + 0.4 * (found / mentions.length)
    }
    const wrongDoor = calls.filter((c) => {
      const d = catalog.domainOf.get(c.payload.name)
      return d !== undefined && d !== ADRATE_DOMAIN
    }).length
    return Math.max(0, Math.min(1, score - 0.25 * wrongDoor))
  }
}

export interface ToolDiscoverySuite {
  catalog: Catalog
  fixtures: EvalFixture[]
  /** 各任务，给 spike 复用同一组问题 */
  tasks: TaskSpec[]
}

export function toolDiscoveryFixtures(opts: { maxTurns?: number } = {}): ToolDiscoverySuite {
  const catalog = buildCatalog()
  const tools: Tool[] = catalog.tools
  const offDomain = offDomainConstraint(catalog)
  const fixtures: EvalFixture[] = TASKS.map((task) => ({
    id: task.id,
    description: `${task.description}（靶工具 ${task.targets.join(" + ")}，200 件里找）`,
    task: { input: task.input, systemPrompt: TOOL_DISCOVERY_SYSTEM_PROMPT },
    tools,
    constraints: [offDomain],
    completion: completionOf(task, catalog),
    maxTurns: opts.maxTurns ?? 10,
    maxResumes: 0,
  }))
  return { catalog, fixtures, tasks: TASKS }
}
