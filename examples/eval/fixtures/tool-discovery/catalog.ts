/**
 * 工具发现 fixture 的"世界"：一张 200 件的工具表 + 一个小小的 AdRate 假账户（D1 eval）。
 *
 * - 28 件真实 AdRate 操作：从 `examples/adrate/capabilities.json` 生成，说明与 schema 用 examples/adrate/tools.ts 同一份函数
 *   （模型看到的与 dogfood 里一字不差），execute 换成按名字给的固定数据——eval 只考"能不能找对工具、用对参数"，不打真服务
 * - 172 件干扰项：邻近业务领域（CRM、账单、HR、库存、客服……）程序生成，说明与参数都像真的；其中 `metaads_*` 一组是"近似陷阱"
 *   （另一家投放平台的同类操作），任务说的是 AdRate / TikTok，调它就是走错门
 * - 总数 200 是 AdRate 侧规划的规模（本地 capabilities.json 与服务器此刻都只有 29 个操作）。名字全表唯一，按名排序，
 *   生成是确定性的：同一份代码两次生成完全相同，configHash 才稳
 *
 * 全部工具都标 `lazy: true`：`eager` 臂不装 lazyTools 模块，`lazy` 字段被忽略、200 件全给；`lazy` 臂装模块后只给菜单。
 * 两臂唯一的差别就是装不装那个 Socket。
 */
import type { Tool } from "@reinsjs/core"
import { CAPABILITIES, describeOperation, EXCLUDED, inputSchemaOf, toolNameOf } from "../../../adrate/tools.ts"

export const CATALOG_SIZE = 200
export const ADRATE_DOMAIN = "adrate"

// ---- 假账户 ----

export const WORLD = {
  advertiserId: "7000000000000000001",
  otherAdvertiserId: "7000000000000000002",
  /** AdRate schema 里 authId 是整数（TikTok 授权 id）——第一轮 eval 给了字符串 "auth_001"，两族模型都按"不能编 id"停下来问人，是 fixture 的错不是模型的 */
  authId: 1,
  user: { userId: "u_1001", email: "ops@example.test", org: "Example Ads Co." },
  campaigns: [
    { campaignId: "1875000000000001", campaignName: "Spring Sale - Prospecting", operationStatus: "ENABLE", secondaryStatus: "CAMPAIGN_STATUS_ENABLE", budget: "500" },
    { campaignId: "1875000000000002", campaignName: "Retargeting - Cart Abandoners", operationStatus: "ENABLE", secondaryStatus: "CAMPAIGN_STATUS_ENABLE", budget: "300" },
    { campaignId: "1875000000000003", campaignName: "Brand Awareness Q2", operationStatus: "DISABLE", secondaryStatus: "CAMPAIGN_STATUS_DISABLE", budget: "1000" },
    { campaignId: "1875000000000004", campaignName: "Clearance - Old Stock", operationStatus: "DISABLE", secondaryStatus: "CAMPAIGN_STATUS_DISABLE", budget: "200" },
  ],
  /** 近 7 天报表：Spring Sale 有花费，Retargeting 花费为 0，两条 DISABLE 的花费为 0 */
  report: { startDate: "2026-09-07", endDate: "2026-09-13" },
  spend: { "1875000000000001": "412.35", "1875000000000002": "0.00", "1875000000000003": "0.00", "1875000000000004": "0.00" } as Record<string, string>,
  rules: [
    { ruleId: "rule_101", name: "Pause zero-spend", ruleType: "campaign_status", enabled: true },
    { ruleId: "rule_102", name: "Raise budget on ROAS > 3", ruleType: "campaign_budget", enabled: true },
  ],
  stores: [{ storeId: "store_01", storeName: "Example Flagship Store" }],
  gmvmaxCampaigns: [
    { campaignId: "1990000000000001", storeId: "store_01", campaignName: "GMV Max - Flagship", status: "ENABLE", roasTarget: "1.8" },
    { campaignId: "1990000000000002", storeId: "store_02", campaignName: "GMV Max - Outlet", status: "ENABLE", roasTarget: "2.2" },
  ],
} as const

let commandSeq = 0
const command = (extra: Record<string, unknown>) => ({
  commandId: `cmd_${String(++commandSeq).padStart(4, "0")}`,
  status: "succeeded",
  isFinal: true,
  ...extra,
})
const ok = (data: unknown, meta: Record<string, unknown> = {}) => ({ ok: true, data, meta, exitCode: 0 })
const fail = (code: string, message: string) => ({ ok: false, error: { code, message }, exitCode: 1 })

/** 按工具名给固定数据；广告主对不上一律 NOT_FOUND，与真服务同一口径 */
export function cannedAdrate(name: string, input: Record<string, unknown>): unknown {
  const adv = input.advId
  const wrongAdv = adv !== undefined && adv !== WORLD.advertiserId
  switch (name) {
    case "identity_get":
      return ok(WORLD.user)
    case "connections_advertisers_list":
      return ok({
        items: [
          { advertiserId: WORLD.advertiserId, advertiserName: "Example Ads Co. (test)", authId: WORLD.authId },
          { advertiserId: WORLD.otherAdvertiserId, advertiserName: "Example Ads Co. (prod)", authId: 2 },
        ],
      })
    case "ads_campaigns_list":
      if (wrongAdv) return fail("NOT_FOUND", `advertiser ${String(adv)} not found`)
      return ok({ items: WORLD.campaigns, page: input.page ?? 1, pageSize: input.pageSize ?? 20, totalCount: WORLD.campaigns.length })
    case "ads_campaigns_get": {
      if (wrongAdv) return fail("NOT_FOUND", `advertiser ${String(adv)} not found`)
      const c = WORLD.campaigns.find((x) => x.campaignId === input.campaignId)
      return c ? ok(c) : fail("NOT_FOUND", `campaign ${String(input.campaignId)} not found`)
    }
    case "ads_campaigns_report":
      if (wrongAdv) return fail("NOT_FOUND", `advertiser ${String(adv)} not found`)
      return ok({
        startDate: input.startDate,
        endDate: input.endDate,
        rows: WORLD.campaigns.map((c) => ({ campaignId: c.campaignId, campaignName: c.campaignName, spend: WORLD.spend[c.campaignId], impressions: WORLD.spend[c.campaignId] === "0.00" ? 0 : 120345 })),
        totalCount: WORLD.campaigns.length,
      })
    case "ads_campaigns_status":
    case "ads_campaigns_budget": {
      if (wrongAdv) return fail("NOT_FOUND", `advertiser ${String(adv)} not found`)
      const c = WORLD.campaigns.find((x) => x.campaignId === input.campaignId)
      if (!c) return fail("NOT_FOUND", `campaign ${String(input.campaignId)} not found`)
      return ok(command({ campaignId: c.campaignId, applied: name === "ads_campaigns_status" ? { operationStatus: input.desiredStatus } : { mode: input.mode, value: input.value } }))
    }
    case "rules_list":
      return ok({ items: WORLD.rules, totalCount: WORLD.rules.length })
    case "rules_get": {
      const r = WORLD.rules.find((x) => x.ruleId === input.ruleId)
      return r ? ok(r) : fail("NOT_FOUND", `rule ${String(input.ruleId)} not found`)
    }
    case "rules_enable":
    case "rules_disable": {
      const r = WORLD.rules.find((x) => x.ruleId === input.ruleId)
      if (!r) return fail("NOT_FOUND", `rule ${String(input.ruleId)} not found`)
      return ok(command({ ruleId: r.ruleId, enabled: name === "rules_enable" }))
    }
    case "gmvmax_stores_list":
      if (wrongAdv) return fail("NOT_FOUND", `advertiser ${String(adv)} not found`)
      return ok({ items: WORLD.stores })
    case "gmvmax_campaigns_list": {
      if (wrongAdv) return fail("NOT_FOUND", `advertiser ${String(adv)} not found`)
      const items = WORLD.gmvmaxCampaigns.filter((c) => input.storeId === undefined || c.storeId === input.storeId)
      return ok({ items, totalCount: items.length })
    }
    case "gmvmax_campaigns_get": {
      if (wrongAdv) return fail("NOT_FOUND", `advertiser ${String(adv)} not found`)
      const c = WORLD.gmvmaxCampaigns.find((x) => x.campaignId === input.campaignId)
      return c ? ok(c) : fail("NOT_FOUND", `campaign ${String(input.campaignId)} not found`)
    }
    case "gmvmax_campaigns_status":
    case "gmvmax_campaigns_budget":
    case "gmvmax_campaigns_roas": {
      if (wrongAdv) return fail("NOT_FOUND", `advertiser ${String(adv)} not found`)
      const c = WORLD.gmvmaxCampaigns.find((x) => x.campaignId === input.campaignId)
      if (!c) return fail("NOT_FOUND", `campaign ${String(input.campaignId)} not found`)
      return ok(command({ campaignId: c.campaignId, applied: { ...input } }))
    }
    default:
      return ok({ accepted: true, input })
  }
}

// ---- 干扰项 ----

interface Domain {
  key: string
  label: string
  resources: [string, string]
  /** 每个资源上的动作；metaads 用投放同款动词做"近似陷阱" */
  verbs: string[]
}

const VERBS = ["list", "get", "create", "update"]
const DOMAINS: Domain[] = [
  { key: "crm", label: "the CRM", resources: ["contacts", "deals"], verbs: VERBS },
  { key: "billing", label: "Billing", resources: ["invoices", "subscriptions"], verbs: VERBS },
  { key: "hr", label: "the HR system", resources: ["employees", "leave_requests"], verbs: VERBS },
  { key: "inventory", label: "Inventory", resources: ["products", "stock_levels"], verbs: VERBS },
  { key: "support", label: "the Support desk", resources: ["tickets", "macros"], verbs: VERBS },
  { key: "analytics", label: "Analytics", resources: ["dashboards", "funnels"], verbs: VERBS },
  { key: "email", label: "Email marketing", resources: ["newsletters", "templates"], verbs: VERBS },
  { key: "calendar", label: "the Calendar", resources: ["events", "rooms"], verbs: VERBS },
  { key: "docs", label: "the Document store", resources: ["documents", "folders"], verbs: VERBS },
  { key: "cms", label: "the CMS", resources: ["pages", "media_assets"], verbs: VERBS },
  { key: "payments", label: "Payments", resources: ["charges", "refunds"], verbs: VERBS },
  { key: "shipping", label: "Shipping", resources: ["shipments", "carriers"], verbs: VERBS },
  { key: "seo", label: "the SEO suite", resources: ["keywords", "backlinks"], verbs: VERBS },
  { key: "social", label: "Social publishing", resources: ["posts", "accounts"], verbs: VERBS },
  { key: "survey", label: "Surveys", resources: ["surveys", "responses"], verbs: VERBS },
  { key: "wiki", label: "the Wiki", resources: ["articles", "spaces"], verbs: VERBS },
  { key: "chat", label: "Team chat", resources: ["channels", "messages"], verbs: VERBS },
  { key: "video", label: "the Video platform", resources: ["uploads", "playlists"], verbs: VERBS },
  { key: "translate", label: "Translation", resources: ["glossaries", "jobs"], verbs: VERBS },
  { key: "security", label: "Security", resources: ["audit_logs", "api_keys"], verbs: VERBS },
  { key: "projects", label: "Project tracking", resources: ["tasks", "sprints"], verbs: VERBS },
  // 近似陷阱：另一家投放平台，动词与 AdRate 同款
  { key: "metaads", label: "Meta Ads (Facebook / Instagram)", resources: ["campaigns", "adsets"], verbs: ["list", "get", "status", "budget", "report"] },
]

const VERB_TEXT: Record<string, (label: string, res: string) => string> = {
  list: (l, r) => `List ${human(r)} in ${l}, paginated. Filters are optional; results are sorted by last update.`,
  get: (l, r) => `Fetch one of the ${human(r)} in ${l} by id, including its full detail record.`,
  create: (l, r) => `Create a new entry among the ${human(r)} in ${l}. Returns the created record with its id.`,
  update: (l, r) => `Update fields of one of the ${human(r)} in ${l}. Only the provided fields change.`,
  status: (l, r) => `Enable or disable one of the ${human(r)} in ${l}. This is a write; it queues a change and returns a command record.`,
  budget: (l, r) => `Change the daily or lifetime budget of one of the ${human(r)} in ${l}. This is a write; returns a command record.`,
  report: (l, r) => `Pull a performance report for the ${human(r)} in ${l} over a date range (spend, impressions, clicks).`,
}
function human(res: string): string {
  return res.replaceAll("_", " ")
}
function singular(res: string): string {
  return res.endsWith("s") ? res.slice(0, -1) : res
}

function distractorSchema(verb: string, res: string): Record<string, unknown> {
  const id = `${singular(res)}Id`
  const props: Record<string, unknown> = {}
  const required: string[] = []
  switch (verb) {
    case "list":
      props.query = { type: "string", description: "Free-text filter" }
      props.page = { type: "integer", minimum: 1, default: 1 }
      props.pageSize = { type: "integer", minimum: 1, maximum: 100, default: 20 }
      break
    case "get":
      props[id] = { type: "string", description: `Opaque ${human(singular(res))} id` }
      required.push(id)
      break
    case "create":
      props.name = { type: "string" }
      props.attributes = { type: "object", description: "Field values for the new record" }
      required.push("name")
      break
    case "update":
      props[id] = { type: "string" }
      props.changes = { type: "object", description: "Fields to change" }
      required.push(id, "changes")
      break
    case "status":
      props.accountId = { type: "string" }
      props[id] = { type: "string" }
      props.desiredStatus = { type: "string", enum: ["ACTIVE", "PAUSED"] }
      required.push("accountId", id, "desiredStatus")
      break
    case "budget":
      props.accountId = { type: "string" }
      props[id] = { type: "string" }
      props.mode = { type: "string", enum: ["daily", "lifetime"] }
      props.value = { type: "number" }
      required.push("accountId", id, "mode", "value")
      break
    case "report":
      props.accountId = { type: "string" }
      props.startDate = { type: "string", description: "YYYY-MM-DD" }
      props.endDate = { type: "string", description: "YYYY-MM-DD" }
      required.push("accountId", "startDate", "endDate")
      break
  }
  return { type: "object", additionalProperties: false, properties: props, required }
}

function distractors(count: number): { tool: Tool; domain: string }[] {
  const out: { tool: Tool; domain: string }[] = []
  for (const d of DOMAINS) {
    for (const res of d.resources) {
      for (const verb of d.verbs) {
        const name = `${d.key}_${res}_${verb}`
        const text = VERB_TEXT[verb]
        if (!text) throw new Error(`没有 ${verb} 的说明模板`)
        out.push({
          domain: d.key,
          tool: {
            name,
            description: `${text(d.label, res)}\nReturns a JSON envelope; ok is the only success signal.`,
            inputSchema: distractorSchema(verb, res),
            risk: verb === "list" || verb === "get" || verb === "report" ? "low" : "high",
            lazy: true,
            execute: (input) => JSON.stringify(ok({ accepted: true, tool: name, input })),
          },
        })
      }
    }
  }
  // 陷阱一组全留，其余按名排序后取前 count - 陷阱数 —— 确定性
  const traps = out.filter((x) => x.domain === "metaads")
  const rest = out.filter((x) => x.domain !== "metaads").sort((a, b) => (a.tool.name < b.tool.name ? -1 : 1))
  const need = count - traps.length
  if (need < 0 || need > rest.length) throw new Error(`干扰项只能生成 ${rest.length + traps.length} 件，要 ${count}`)
  return [...rest.slice(0, need), ...traps]
}

// ---- 目录 ----

export interface Catalog {
  /** 200 件，按名排序，全部 lazy: true */
  tools: Tool[]
  /** 工具名 → 领域（"adrate" 或干扰项的 domain key） */
  domainOf: Map<string, string>
  adrateNames: string[]
}

export function buildCatalog(size = CATALOG_SIZE): Catalog {
  const entries: { tool: Tool; domain: string }[] = []
  for (const cap of CAPABILITIES.capabilities) {
    for (const op of cap.operations) {
      if (EXCLUDED.has(op.operationId) || op.available === false) continue
      const name = toolNameOf(op.operationId)
      entries.push({
        domain: ADRATE_DOMAIN,
        tool: {
          name,
          description: describeOperation(cap, op),
          inputSchema: inputSchemaOf(op),
          risk: cap.risk === "high" ? "high" : "low",
          lazy: true,
          execute: (input) => JSON.stringify(cannedAdrate(name, (input ?? {}) as Record<string, unknown>)),
        },
      })
    }
  }
  const adrateNames = entries.map((e) => e.tool.name)
  entries.push(...distractors(size - entries.length))
  entries.sort((a, b) => (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0))
  const names = new Set<string>()
  for (const e of entries) {
    if (names.has(e.tool.name)) throw new Error(`工具名重复：${e.tool.name}`)
    names.add(e.tool.name)
  }
  return { tools: entries.map((e) => e.tool), domainOf: new Map(entries.map((e) => [e.tool.name, e.domain])), adrateNames }
}
