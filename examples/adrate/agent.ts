/**
 * dogfood agent：AdRate CLI 工具 + 全部脑子模块 + SQLite 存储 + 经网关的模型。
 *
 * 模型来源（`REINS_PROVIDER`）：`aireiter`（缺省，claude-opus-5）或 `deepseek`（deepseek-v4-flash）；密钥从仓库根
 * `模型API测试信息.md` 读（已 gitignore），也可用 ANTHROPIC_API_KEY 覆盖。`REINS_MODEL` 覆盖模型 id。
 *
 * 系统提示 = 角色与任务约定 + AdRate 自带的两份 Agent Skill 全文（安全契约、广告操作契约）。
 * Skill 文本是给任何 agent 的操作说明，正好当规则；它稳定不变，前缀缓存不受影响。
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { approval, budget, compact, handoff, memory, perception, pins, spill } from "@reins/brain"
import { anthropic } from "@reins/lowering-pi"
import { sqliteStores } from "@reins/store-sqlite"
import { openSqlite } from "@reins/store-sqlite/node"
import { createAgent } from "reins"
import { adrateTools } from "./tools.ts"

const here = (p: string) => new URL(p, import.meta.url)

function readKey(section: "aireiter" | "deepseek"): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  const info = readFileSync(here("../../模型API测试信息.md"), "utf8")
  const keys = [...info.matchAll(/密钥[^`]*`(sk-[^`]+)`/g)].map((m) => m[1] as string)
  const key = section === "aireiter" ? keys[0] : keys[1]
  if (!key) throw new Error(`没在 模型API测试信息.md 里找到 ${section} 的密钥；或设 ANTHROPIC_API_KEY`)
  return key
}

const provider = (process.env.REINS_PROVIDER ?? "aireiter") as "aireiter" | "deepseek"
const modelId = process.env.REINS_MODEL ?? (provider === "deepseek" ? "deepseek-v4-flash" : "claude-opus-5")
const baseUrl = provider === "deepseek" ? "https://api.deepseek.com/anthropic" : "https://aireiter.com/api"

const skill = (name: string) => execFileSync("adrate", ["skills", "read", name], { encoding: "utf8" })

export const ADVERTISER_ID = "7000000000000000001"

const ROLE = `你是 AdRate（TikTok 广告投放工具）的运营助手，替 Owner 完成需要很多步的广告账户操作。
工作方式：
- 只通过给你的工具操作 AdRate；每个工具返回 AdRate 的 JSON 信封，只有 ok === true 才算成功。
- 写操作（改状态、改预算、提交复制、规则增删改）会先经 Owner 审批再执行；被拒绝就换方案或如实汇报，不要重复提交同一意图。
- 幂等键由系统按每次调用自动生成并随结果返回；exitCode 4/5 时用返回的 idempotencyKey 走 commands_get / commands_resume 对账，绝不换键重发。
- 遇到 RATE_LIMITED / RESOURCE_BUSY 用 wait_seconds 等 Retry-After 再试，设定有限次数；DAILY_QUOTA_EXCEEDED 立即停止并汇报。
- 分页要按 meta.pagination 读到需要为止，不要凭一页下结论；报表里 null 是 N/A 不是 0。
- 长任务中要紧的中间结论（候选清单、已确认的 Command 终态、待办）用 pin 钉住，完成后给 Owner 一张简明汇总表。
- 用中文向 Owner 汇报，简短直接。

下面是 AdRate 官方给 Agent 的两份操作契约，全文遵守：`

export const agent = createAgent({
  model: anthropic(modelId, {
    apiKey: readKey(provider),
    baseUrl,
    requestOptions: { thinkingEnabled: true, thinkingBudgetTokens: 2048 },
    // DeepSeek 的 Anthropic 端口实测接受中途 system（DECISIONS 2026-09-08 B1 附），感知 / pin 说明走 exact 落点
    ...(provider === "deepseek" ? { midConversationSystem: true } : {}),
  }),
  store: (() => {
    mkdirSync(here("./data/").pathname, { recursive: true })
    return sqliteStores(openSqlite(here("./data/adrate.db").pathname))
  })(),
  tools: adrateTools(),
  systemPrompt: `${ROLE}\n\n${skill("adrate-shared")}\n\n${skill("adrate-ads")}`,
  sockets: [
    perception({ limits: { toolCalls: 120, wallMs: 40 * 60_000 } }),
    compact(),
    pins({ pins: [{ name: "advertiser", text: `本任务只操作测试广告主 ${ADVERTISER_ID}（可随意写，不会投出去）。` }] }),
    spill({ maxResultTokens: 6000, previewLines: 12 }),
    memory(),
    handoff(),
    budget({ limits: { toolCalls: 120, wallMs: 40 * 60_000, totalTokens: 4_000_000 } }),
    approval({ unmatched: "byRisk" }), // 读放行、写先问人；放最后，判定的是真正要执行的入参
  ],
  maxTurns: 150,
  secret: process.env.REINS_SECRET ?? "dogfood-only-secret",
})
