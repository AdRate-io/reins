/**
 * 三个角色，一套 Postgres 存储。
 *
 * - `analyst`（数据分析师）：两个只读工具，看库存与周销量；记忆前缀 /roles/analyst/users/<principal>
 * - `writer`（文案）：一个只读工具（品牌语气指南）；记忆前缀 /roles/writer/users/<principal>
 * - `lead`（运营负责人，编排者）：工具表上只有两个专家 —— ask_analyst（父停子停）与 ask_writer（接力，不联停）；
 *   记忆前缀 /roles/lead/users/<principal>；只有它装 approval 模块（信任边界收在这一层）
 *
 * 三个角色共用同一个 EventLog / BlobStore / MemoryStore（同一张表），靠 memory 的 namespace 前缀隔离（技术方案 §9.6 三层里的第二层）；
 * 要按角色分表，把 `pgStores(client, { memoryTable: "analyst_memory" })` 各建一套即可（第一层）。角色不进事件、不进存储 —— 哪个角色
 * 由"哪个 createAgent"决定。
 *
 * 模型：REINS_PROVIDER=deepseek（缺省，deepseek-v4-flash）或 aireiter（claude-opus-5）；密钥从仓库根《模型API测试信息.md》读，
 * ANTHROPIC_API_KEY 可覆盖；REINS_MODEL 覆盖模型 id。存储：PGlite 文件库 data/team.pgdata（真 Postgres 换成 `new pg.Pool(...)` 传进去）。
 */
import { mkdirSync, readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { approval, budget, compact, memory, perception, pins } from "@reinsjs/brain"
import { anthropic } from "@reinsjs/lowering-pi"
import { pgStores } from "@reinsjs/store-pg"
import { type Agent, createAgent, defineTool, type ToolContext } from "reins"
import { expertTool } from "./subagent-tool.ts"

const here = (p: string) => new URL(p, import.meta.url)

function readKey(section: "aireiter" | "deepseek"): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  const info = readFileSync(here("../../模型API测试信息.md"), "utf8")
  const keys = [...info.matchAll(/密钥[^`]*`(sk-[^`]+)`/g)].map((m) => m[1] as string)
  const key = section === "aireiter" ? keys[0] : keys[1]
  if (!key) throw new Error(`没在 模型API测试信息.md 里找到 ${section} 的密钥；或设 ANTHROPIC_API_KEY`)
  return key
}

const provider = (process.env.REINS_PROVIDER ?? "deepseek") as "aireiter" | "deepseek"
const modelId = process.env.REINS_MODEL ?? (provider === "deepseek" ? "deepseek-v4-flash" : "claude-opus-5")
const baseUrl = provider === "deepseek" ? "https://api.deepseek.com/anthropic" : "https://aireiter.com/api"

export const model = anthropic(modelId, {
  apiKey: readKey(provider),
  baseUrl,
  requestOptions: { thinkingEnabled: true, thinkingBudgetTokens: 2048 },
  ...(provider === "deepseek" ? { midConversationSystem: true } : {}),
})

// ---- 存储：一套，三个角色共用 ----
mkdirSync(here("./data/").pathname, { recursive: true })
const pglite = new PGlite(here("./data/team.pgdata").pathname)
export const store = await pgStores(pglite)
export async function closeStore(): Promise<void> {
  await pglite.close()
}

const secret = process.env.REINS_SECRET ?? "dev-only-secret"
/** 每个角色一块记忆，再按 principal 分用户：模型看到的永远是 /memories */
const roleMemory = (role: string) =>
  memory({ namespace: (ctx: ToolContext) => `/roles/${role}/users/${ctx.principal?.id ?? "anonymous"}` })
/** 专家共用的脑子：不装 approval（⑤，信任边界在 lead 的工具表上） */
const expertBrain = (role: string) => [
  perception(),
  compact(),
  pins(),
  roleMemory(role),
  budget({ limits: { turns: 12, toolCalls: 20 } }),
]

// ---- 数据与只读工具 ----
interface Catalog {
  asOf: string
  skus: { sku: string; name: string; stock: number; unitCost: number; weeklySales: number[] }[]
}
const catalog = (): Catalog => JSON.parse(readFileSync(here("./data/catalog.json"), "utf8")) as Catalog

const listSkus = defineTool<Record<string, never>>({
  name: "list_skus",
  description: "List every SKU with current stock units and unit cost. Sales history is a separate call.",
  inputSchema: { type: "object", properties: {} },
  risk: "low",
  execute: () => {
    const c = catalog()
    return { asOf: c.asOf, skus: c.skus.map(({ sku, name, stock, unitCost }) => ({ sku, name, stock, unitCost })) }
  },
})

const weeklySales = defineTool<{ sku: string }>({
  name: "weekly_sales",
  description: "Units sold per week for one SKU over the last 6 weeks, oldest first.",
  inputSchema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
  risk: "low",
  validate(input) {
    const sku = (input as { sku?: unknown } | null)?.sku
    if (typeof sku !== "string") throw new Error("sku 必须是字符串")
    return { sku }
  },
  execute: ({ sku }) => {
    const item = catalog().skus.find((s) => s.sku === sku)
    if (!item) return { content: [{ type: "text", text: `unknown sku ${sku}` }], isError: true }
    return { sku, weeklySales: item.weeklySales, weeksOfStock: +(item.stock / Math.max(1, item.weeklySales.at(-1) ?? 1)).toFixed(1) }
  },
})

const brandVoice = defineTool<Record<string, never>>({
  name: "brand_voice",
  description: "The brand's copywriting guidelines. Read before writing any customer-facing copy.",
  inputSchema: { type: "object", properties: {} },
  risk: "low",
  execute: () => ({
    tone: "直接、克制、不喊口号；像懂行的朋友在推荐",
    rules: ["不用感叹号", "价格与折扣只说一次", "必须点明是清库存活动，不装成新品", "结尾给一个明确的行动"],
    maxChars: 80,
  }),
})

// ---- 两个专家 ----
export const analyst: Agent = createAgent({
  model,
  store,
  tools: [listSkus, weeklySales],
  systemPrompt: `You are a retail inventory analyst. Work only from the tools; do not invent numbers.
Be decisive: when asked to pick SKUs, pick them and say why in one line each (stock, weeks of stock at current pace, sales trend).
Answer in Chinese with a compact markdown table. No preamble.`,
  sockets: expertBrain("analyst"),
  secret,
})

export const writer: Agent = createAgent({
  model,
  store,
  tools: [brandVoice],
  systemPrompt: `You are the brand copywriter. Always read brand_voice first, then write exactly what was asked, within the character limit.
Return only the copy, in Chinese. No explanations.`,
  sockets: expertBrain("writer"),
  secret,
})

// ---- 编排者：工具表上只有两个专家 ----
export const lead: Agent = createAgent({
  model,
  store,
  tools: [
    // ① 分析是问答：父停子停
    expertTool({
      name: "ask_analyst",
      role: "analyst",
      agent: analyst,
      abort: "linked",
      description:
        "Ask the inventory analyst. They have live stock and 6-week sales data and will pick, rank or explain SKUs. Give a self-contained question.",
    }),
    // ① 文案是接力：父中止了文案也写完（结果仍落父日志，父才暂停）
    expertTool({
      name: "ask_writer",
      role: "writer",
      agent: writer,
      abort: "detached",
      description:
        "Ask the brand copywriter for customer-facing copy. Include everything they need (products, offer, length limit) — they see none of your conversation.",
    }),
  ],
  systemPrompt: `You are the operations lead of a small apparel brand. You do not analyse data or write copy yourself: delegate to ask_analyst and ask_writer, then assemble.
Each expert call returns JSON with childSessionId, status, answer and usage. If status is not "done", read detail and decide what to do; never retry the same call blindly.
Finish in Chinese with: (1) the analyst's SKU table, (2) the copy verbatim, (3) one line listing each expert's childSessionId and token usage.`,
  sockets: [
    perception(),
    compact(),
    pins(),
    roleMemory("lead"),
    budget({ limits: { turns: 10, toolCalls: 8 } }),
    // approval 放末尾，判定 rewrite 之后的真实入参。缺省 byRisk：两个专家工具 risk=low 直接放行；专家一旦有写工具，把 risk 提上去
    approval(),
  ],
  secret,
})

/** 回放脚本（examples/minimal/replay.ts --agent）要一个叫 agent 的导出：编排者 */
export const agent = lead
export const EXPERT_TOOL_NAMES: ReadonlySet<string> = new Set(["ask_analyst", "ask_writer"])
