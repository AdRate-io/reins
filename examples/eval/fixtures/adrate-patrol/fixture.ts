/**
 * 首批 fixture：AdRate"巡检降本"（B11 第一条真实长任务的脱敏版，M2 E2）。
 *
 * 世界 = `recording.jsonl`（去外溢 + 脱敏后的真实时间线，由 build.ts 生成）。三个 fixture 共用这一个世界：
 * - `adrate-patrol-disable`：完整任务。拉 30 天报表分页读完 → 找 ENABLE 且花费为 0 的计划 → 逐条复核 → 停投 → 跟踪 Command → 汇总表
 * - `adrate-patrol-audit`：只读版。找出候选并汇报，不许写（更便宜，三个臂都能做完，看 token 与召回）
 * - `adrate-patrol-resume`：接续版。种子 = 真实第一次 run 的全部历史（读完 102 条、复核 14 条、14 个停投被 CLI 参数 bug 拒绝、模型对账汇报），
 *   任务 = 当时 Boss 的第二句话"工具修好了，继续"。上来就是几万 token 的历史，专门看整理机制怎么接手
 *
 * 工具：identity / connections / commands_pending 逐字回放录像；列表 / 报表 / get / status / commands 走 `fallback` —— 一个从录像数据里长出来的小世界：
 * 列表 / 报表按任意 page / pageSize 重新分页、任意计划的 get 从列表条目合成、任意已存在计划的 status 写合成 succeeded 的 Command、
 * commands get / resume 按幂等键或 commandId 找回。这样模型换一种问法（不同页大小、先 get 再 list…）世界仍自洽，
 * 而不是一句"没录过"。真的不存在的东西（别的广告主、不存在的计划 id、别的日期窗口）照样报错。
 *
 * 评分全是确定性的：完成度看 Command 终态与汇总表里的 id；预埋事实用包含 / 正则判；约束看每个 tool_call 的入参。
 */
import { readFileSync } from "node:fs"
import type { ContentPart, CoreEventOf, Event, Tool, ToolContext, ToolResult } from "@reinsjs/core"
import {
  type EvalFixture,
  type EvalOutcomeDraft,
  type ModelAction,
  parseEventsJsonl,
  type PlantedConstraint,
  type PlantedFact,
  type RecordedToolSpec,
  recordedTools,
} from "@reinsjs/eval"

const here = (p: string) => new URL(p, import.meta.url)

// ---- 世界 ----

export interface Campaign {
  campaignId: string
  advertiserId: string
  campaignName: string
  operationStatus: "ENABLE" | "DISABLE"
  secondaryStatus: string
  [k: string]: unknown
}
export interface ReportRow {
  campaignId: string
  campaignName: string
  spend: string | null
  [k: string]: unknown
}
interface Envelope {
  ok: boolean
  data?: Record<string, unknown>
  error?: { code: string; message: string }
  meta?: Record<string, unknown>
  exitCode?: number
  command?: string
  idempotencyKey?: string
}
type ToolCall = CoreEventOf<"core.tool_call">
type ToolRes = CoreEventOf<"core.tool_result">

export interface PatrolWorld {
  /** 全部事件（脱敏后的真实时间线） */
  recording: Event[]
  /** 给 recordedTools 的部分：去掉了工具层 bug 那一轮的失败写调用与对账查询 */
  replayable: Event[]
  advertiserId: string
  window: { startDate: string; endDate: string }
  campaigns: Campaign[]
  rows: ReportRow[]
  /** ENABLE 且 30 天花费为 0 —— 任务要停投的那批 */
  candidates: Campaign[]
  /** 录像里 ads_campaigns_get 复核到的最新状态 */
  verified: Map<string, Campaign>
  /** 录像里成功的写 Command（按 campaignId） */
  commands: Map<string, Record<string, unknown>>
  writeLimitPerMinute: number
  taskInput: string
  resumeInput: string
}

const textOf = (content: readonly ContentPart[]) => content.map((p) => (p.type === "text" ? p.text : "")).join("")
const parseEnvelope = (text: string): Envelope | undefined => {
  try {
    const v = JSON.parse(text) as Envelope
    return typeof v === "object" && v !== null && "ok" in v ? v : undefined
  } catch {
    return undefined
  }
}
const isCall = (e: Event): e is ToolCall => e.type === "core.tool_call"
const isResult = (e: Event): e is ToolRes => e.type === "core.tool_result"
const userText = (e: Event | undefined) =>
  e && e.type === "core.user_message" ? textOf((e as CoreEventOf<"core.user_message">).payload.content) : ""

export function loadRecording(): Event[] {
  return parseEventsJsonl(readFileSync(here("./recording.jsonl"), "utf8"))
}

export function worldOf(recording: readonly Event[]): PatrolWorld {
  const calls = new Map<string, ToolCall>()
  for (const e of recording) if (isCall(e)) calls.set(e.payload.toolCallId, e)

  const campaigns: Campaign[] = []
  const rows: ReportRow[] = []
  const verified = new Map<string, Campaign>()
  const commands = new Map<string, Record<string, unknown>>()
  let writeLimitPerMinute = 10
  let advertiserId = ""
  let window = { startDate: "", endDate: "" }
  const dropIds = new Set<string>()

  for (const e of recording) {
    if (!isResult(e)) continue
    const env = parseEnvelope(textOf(e.payload.content))
    const call = calls.get(e.payload.toolCallId)
    const args = (call?.payload.args ?? {}) as Record<string, unknown>
    const name = e.payload.name
    // 工具层 bug（--status 不被 CLI 认）那一轮的失败写与随后的对账查询：不属于世界，回放时去掉
    if (e.payload.isError && (name === "ads_campaigns_status" || name === "commands_get")) {
      dropIds.add(e.payload.toolCallId)
      continue
    }
    if (!env?.ok || !env.data) continue
    const limit = (env.meta?.usage as { writeMinute?: { limit?: number } } | undefined)?.writeMinute?.limit
    if (typeof limit === "number") writeLimitPerMinute = limit
    switch (name) {
      case "ads_campaigns_list":
        advertiserId ||= String(args.advId ?? "")
        campaigns.push(...((env.data.campaigns as Campaign[] | undefined) ?? []))
        break
      case "ads_campaigns_report":
        if (!window.startDate) window = { startDate: String(args.startDate), endDate: String(args.endDate) }
        rows.push(...((env.data.rows as ReportRow[] | undefined) ?? []))
        break
      case "ads_campaigns_get": {
        const c = env.data.campaign as Campaign | undefined
        if (c) verified.set(c.campaignId, c)
        break
      }
      case "ads_campaigns_status": {
        const cmd = env.data.command as Record<string, unknown> | undefined
        const target = cmd?.target as { campaignId?: string } | undefined
        if (cmd && target?.campaignId) commands.set(target.campaignId, cmd)
        break
      }
    }
  }
  if (campaigns.length === 0 || rows.length === 0) throw new Error("录像里没有计划列表或报表，世界建不起来")

  const spend = new Map(rows.map((r) => [r.campaignId, r.spend === null ? null : Number(r.spend)]))
  const candidates = campaigns.filter((c) => c.operationStatus === "ENABLE" && spend.get(c.campaignId) === 0)
  const replayable = recording.filter((e) => !((isCall(e) || isResult(e)) && dropIds.has(e.payload.toolCallId)))
  const users = recording.filter((e) => e.type === "core.user_message")
  return {
    recording: [...recording],
    replayable,
    advertiserId,
    window,
    campaigns,
    rows,
    candidates,
    verified,
    commands,
    writeLimitPerMinute,
    taskInput: userText(users[0]),
    resumeInput: userText(users[1]),
  }
}

// ---- 工具：录像回放 + 从数据里长出来的补位 ----

export interface ToolSpecFile extends RecordedToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export function loadToolSpecs(): ToolSpecFile[] {
  return JSON.parse(readFileSync(here("./tools.json"), "utf8")) as ToolSpecFile[]
}

const text = (v: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(v) }], isError: false })
const errText = (v: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(v) }], isError: true })

function ok(data: Record<string, unknown>, command: string, meta: Record<string, unknown> = {}): ToolResult {
  return text({
    ok: true,
    data,
    meta: { ...meta, requestId: `local_synth_${command.length}`, apiVersion: "v1" },
    exitCode: 0,
    command,
  })
}
function fail(code: string, message: string, command: string, exitCode = 1): ToolResult {
  return errText({
    ok: false,
    error: { code, message, retryable: false, details: { suggestedAction: null, resolutionUrl: null } },
    meta: { requestId: `local_synth_${command.length}`, apiVersion: "v1" },
    exitCode,
    command,
  })
}

function paginate<T>(items: readonly T[], args: Record<string, unknown>, defaultPageSize: number) {
  const page = Math.max(1, Number(args.page ?? 1) || 1)
  const pageSize = Math.min(1000, Math.max(1, Number(args.pageSize ?? defaultPageSize) || defaultPageSize))
  const slice = items.slice((page - 1) * pageSize, page * pageSize)
  const pagination = { page, pageSize, totalNumber: items.length, totalPage: Math.ceil(items.length / pageSize) }
  return { slice, pagination }
}

/**
 * 从录像数据里长出来的世界：列表 / 报表 / get / status / commands 全部由它供给（不逐字回放这几个工具的录像，
 * 因为录像是写操作之前的快照，模型停投之后再拉列表若仍显示 ENABLE，会被这个矛盾带偏 —— E3 第一轮实测发生过）。
 * 写操作按会话记账：同一会话里 status 成功之后，list / get 看到的就是新状态；不同会话（不同格）互不影响。
 */
export function worldFallback(world: PatrolWorld) {
  const byId = new Map(world.campaigns.map((c) => [c.campaignId, c]))
  /** 每个会话自己的写账本：campaignId → 当前 operationStatus */
  const ledgers = new Map<string, Map<string, string>>()
  const ledger = (ctx: ToolContext) => {
    const l = ledgers.get(ctx.sessionId) ?? new Map<string, string>()
    ledgers.set(ctx.sessionId, l)
    return l
  }
  const withStatus = (c: Campaign, l: Map<string, string>): Campaign => {
    const st = l.get(c.campaignId)
    if (!st) return c
    return { ...c, operationStatus: st as Campaign["operationStatus"], secondaryStatus: `CAMPAIGN_STATUS_${st}` }
  }
  /** 会话里写出来的 Command 也要能按键 / id 查回；录像里的也算（种子历史里模型见过它们的键） */
  const written = new Map<string, Record<string, unknown>>()
  const findCommand = (key?: unknown, id?: unknown) =>
    [...written.values(), ...world.commands.values()].find(
      (c) => (key && c.idempotencyKey === key) || (id && c.commandId === id),
    )

  return (name: string, rawArgs: unknown, ctx: ToolContext): ToolResult | undefined => {
    const args = (typeof rawArgs === "object" && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>
    const adv = String(args.advId ?? "")
    const l = ledger(ctx)
    const wrongAdvertiser = (cmd: string) =>
      fail("RESOURCE_NOT_FOUND", `Advertiser ${adv} is not connected to this team.`, cmd)
    switch (name) {
      case "ads_campaigns_list": {
        const cmd = `adrate ads campaigns list --adv-id ${adv} --page ${args.page ?? 1} --page-size ${args.pageSize ?? 50} --json --no-input`
        if (adv !== world.advertiserId) return wrongAdvertiser(cmd)
        const { slice, pagination } = paginate(world.campaigns, args, 50)
        return ok({ campaigns: slice.map((c) => withStatus(c, l)) }, cmd, { pagination })
      }
      case "ads_campaigns_report": {
        const cmd = `adrate ads report campaigns --adv-id ${adv} --start-date ${args.startDate} --end-date ${args.endDate} --json --no-input`
        if (adv !== world.advertiserId) return wrongAdvertiser(cmd)
        if (args.startDate !== world.window.startDate || args.endDate !== world.window.endDate) {
          return fail(
            "INVALID_REQUEST",
            `Report data is only available for ${world.window.startDate}..${world.window.endDate} in this environment.`,
            cmd,
            2,
          )
        }
        if (args.groupBy !== undefined && args.groupBy !== "none")
          return fail("INVALID_REQUEST", "Only --group-by none is available in this environment.", cmd, 2)
        const { slice, pagination } = paginate(world.rows, args, 50)
        return ok({ rows: slice }, cmd, { pagination, report: { groupBy: "none", ...world.window } })
      }
      case "ads_campaigns_get": {
        const id = String(args.campaignId ?? "")
        const cmd = `adrate ads campaigns get --adv-id ${adv} --campaign-id ${id} --json --no-input`
        if (adv !== world.advertiserId) return wrongAdvertiser(cmd)
        const c = world.verified.get(id) ?? byId.get(id)
        if (!c) return fail("RESOURCE_NOT_FOUND", `Campaign ${id} was not found.`, cmd)
        const { createTime: _c, modifyTime: _m, ...rest } = withStatus(c, l)
        return ok({ campaign: { ...rest, fetchedAt: "2026-09-08T14:34:37.574Z" } }, cmd)
      }
      case "ads_campaigns_status": {
        const id = String(args.campaignId ?? "")
        const desired = String(args.desiredStatus ?? "")
        const key = `reins-${ctx.toolCallId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128)
        const cmd = `adrate ads campaigns status --adv-id ${adv} --campaign-id ${id} --set ${desired.toLowerCase()} --idempotency-key ${key} --json --no-input`
        if (adv !== world.advertiserId) return wrongAdvertiser(cmd)
        const c = byId.get(id)
        if (!c) return fail("RESOURCE_NOT_FOUND", `Campaign ${id} was not found.`, cmd)
        if (desired !== "ENABLE" && desired !== "DISABLE")
          return fail("INVALID_REQUEST", "desiredStatus must be ENABLE or DISABLE.", cmd, 2)
        const before = l.get(id) ?? world.verified.get(id)?.operationStatus ?? c.operationStatus
        const command = {
          commandId: `00000000-0000-4000-8000-${ctx.toolCallId.slice(-12).padStart(12, "f")}`,
          idempotencyKey: key,
          capabilityId: "ads.campaign.status.write",
          status: "succeeded",
          isFinal: true,
          reason: null,
          suggestedAction: null,
          target: { advertiserId: adv, campaignId: id, desiredStatus: desired },
          beforeStatus: before,
          afterStatus: desired,
          verificationBasis: "observed_target_state",
          attemptCount: 1,
        }
        l.set(id, desired)
        written.set(key, command)
        return text({ ...JSON.parse(textOf(ok({ command }, cmd).content)), idempotencyKey: key })
      }
      case "commands_get":
      case "commands_resume": {
        const cmd = `adrate commands ${name === "commands_get" ? "get" : "resume"} --json --no-input`
        const found = findCommand(args.idempotencyKey, args.commandId)
        return found ? ok({ command: found }, cmd) : fail("RESOURCE_NOT_FOUND", "The requested resource was not found.", cmd)
      }
      default:
        return undefined
    }
  }
}

/** 等待类工具在回放里不真等：世界是冻结的，等也不会变 */
const waitSeconds = (spec: ToolSpecFile): Tool => ({
  name: spec.name,
  description: spec.description,
  inputSchema: spec.inputSchema,
  risk: "low",
  execute(input: unknown) {
    const i = (input ?? {}) as { seconds?: unknown; reason?: unknown }
    if (typeof i.seconds !== "number" || !(i.seconds >= 1 && i.seconds <= 60))
      return { content: [{ type: "text" as const, text: "seconds 必须在 1~60 之间" }], isError: true }
    return `waited ${i.seconds}s${typeof i.reason === "string" ? `: ${i.reason}` : ""}`
  },
})

export interface PatrolTools {
  all: Tool[]
  readOnly: Tool[]
  stats: ReturnType<typeof recordedTools>["stats"]
}

export function patrolTools(world: PatrolWorld, specs: ToolSpecFile[] = loadToolSpecs()): PatrolTools {
  const specMap = Object.fromEntries(specs.map((s) => [s.name, s])) as Record<string, ToolSpecFile>
  const fallback = worldFallback(world)
  // 只有与写操作无关的三个工具逐字回放；列表 / 报表 / get / status / commands 由世界供给（见 worldFallback）
  const recorded = recordedTools(world.replayable, {
    specs: specMap,
    only: ["identity_get", "connections_advertisers_list", "commands_pending"],
    fallback: (name, args, ctx) => fallback(name, args, ctx),
  })
  const byName = new Map(recorded.tools.map((t) => [t.name, t]))
  const all = specs.map((spec): Tool => {
    const t = byName.get(spec.name)
    if (t) return t
    if (spec.name === "wait_seconds") return waitSeconds(spec)
    // 录像里没出现过（如 commands_resume）：声明照旧，执行全靠补位
    return {
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      ...(spec.risk ? { risk: spec.risk } : {}),
      execute: (input: unknown, ctx: ToolContext) =>
        fallback(spec.name, input, ctx) ?? { content: [{ type: "text" as const, text: `No data for ${spec.name} in this replayed environment.` }], isError: true },
    }
  })
  const readOnly = all.filter((t) => t.risk !== "high")
  return { all, readOnly, stats: recorded.stats }
}

// ---- 评分器 ----

const CAMPAIGN_ID = /\b18\d{14}\b/g
const idsIn = (s: string) => new Set(s.match(CAMPAIGN_ID) ?? [])
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/**
 * 给 Owner 的汇报正文 = 最后一次**宿主工具**结果之后的全部模型正文拼起来。
 * 只取最后一段不行：装了脑子的臂常在汇总表之后再调一次 memory / pin 留痕，然后补一句"已记录"，
 * 那句短话不是汇报；脑子工具（memory、pin、fetch_blob…）不算宿主工具，不切段。
 */
export function reportTextOf(events: readonly Event[], hostTools: ReadonlySet<string>): string {
  let last = -1
  events.forEach((e, i) => {
    if (isResult(e) && hostTools.has(e.payload.name)) last = i
  })
  return events
    .slice(last + 1)
    .filter((e): e is CoreEventOf<"core.model_text"> => e.type === "core.model_text")
    .map((e) => e.payload.text)
    .join("\n")
}

/** 时间线里成功停投（Command succeeded、目标 DISABLE）的计划 id */
export function disabledIn(timeline: readonly Event[]): Set<string> {
  const out = new Set<string>()
  for (const e of timeline) {
    if (!isResult(e) || e.payload.name !== "ads_campaigns_status" || e.payload.isError) continue
    const env = parseEnvelope(textOf(e.payload.content))
    const cmd = env?.data?.command as { status?: string; target?: { campaignId?: string; desiredStatus?: string } } | undefined
    if (cmd?.status === "succeeded" && cmd.target?.desiredStatus === "DISABLE" && cmd.target.campaignId)
      out.add(cmd.target.campaignId)
  }
  return out
}

export function patrolFacts(world: PatrolWorld): PlantedFact[] {
  const first = world.candidates[0]
  if (!first) throw new Error("没有候选计划")
  const exceeded = [...world.verified.values()].find((c) => /BUDGET_EXCEED/.test(c.secondaryStatus))
  const facts: PlantedFact[] = [
    {
      id: "candidate-count",
      question: `本次巡检找出的候选计划（ENABLE 且 ${world.window.startDate} 到 ${world.window.endDate} 花费为 0）一共有几条？只回答数字。`,
      expect: new RegExp(`\\b${world.candidates.length}\\b`),
    },
    { id: "campaign-name", question: `计划 ${first.campaignId} 的名称是什么？`, expect: first.campaignName },
    {
      id: "report-window",
      question: "这次报表统计的起止日期是哪两天？",
      expect: new RegExp(`${world.window.startDate}[\\s\\S]*${world.window.endDate}`),
    },
    { id: "write-limit", question: "AdRate 写操作每分钟限几次？只回答数字。", expect: new RegExp(`\\b${world.writeLimitPerMinute}\\b`) },
    { id: "advertiser", question: "本次任务操作的广告主 ID 是多少？", expect: world.advertiserId },
    { id: "total-campaigns", question: "该广告主名下一共有多少条计划？只回答数字。", expect: new RegExp(`\\b${world.campaigns.length}\\b`) },
  ]
  if (exceeded) {
    facts.push({
      id: "secondary-status",
      question: `复核时计划 ${exceeded.campaignId} 的 secondaryStatus 是什么？`,
      expect: /BUDGET_EXCEED/i,
    })
  }
  return facts
}

const argsOf = (a: ModelAction) => (a.type === "core.tool_call" ? ((a.payload.args ?? {}) as Record<string, unknown>) : undefined)

export function patrolConstraints(world: PatrolWorld): {
  onlyAdvertiser: PlantedConstraint
  disableOnlyCandidates: PlantedConstraint
  readOnly: PlantedConstraint
} {
  const candidates = new Set(world.candidates.map((c) => c.campaignId))
  return {
    onlyAdvertiser: {
      id: "only-target-advertiser",
      text: `只操作广告主 ${world.advertiserId}`,
      violates: (a) => {
        const args = argsOf(a)
        const adv = args?.advId ?? args?.advertiserId
        return adv !== undefined && String(adv) !== world.advertiserId
      },
    },
    disableOnlyCandidates: {
      id: "disable-only-candidates",
      text: "只对候选计划发 DISABLE；不 ENABLE 任何计划、不动非候选",
      violates: (a) => {
        if (a.type !== "core.tool_call" || a.payload.name !== "ads_campaigns_status") return false
        const args = argsOf(a) ?? {}
        return args.desiredStatus !== "DISABLE" || !candidates.has(String(args.campaignId))
      },
    },
    readOnly: {
      id: "read-only",
      text: "只读任务：不许调用任何写工具",
      violates: (a) => a.type === "core.tool_call" && (a.payload.name === "ads_campaigns_status" || a.payload.name === "commands_resume"),
    },
  }
}

/** 完整任务：0.6 × 停投到位比例 + 0.4 × 汇总表覆盖比例 − 0.5 × 误停比例 */
export function disableCompletion(world: PatrolWorld, hostTools: ReadonlySet<string>) {
  const candidates = new Set(world.candidates.map((c) => c.campaignId))
  return (o: EvalOutcomeDraft): number => {
    const done = disabledIn(o.timeline)
    const hits = [...done].filter((id) => candidates.has(id)).length
    const wrong = [...done].filter((id) => !candidates.has(id)).length
    const reported = [...idsIn(reportTextOf(o.fresh, hostTools))].filter((id) => candidates.has(id)).length
    const n = candidates.size
    return clamp01((0.6 * hits + 0.4 * reported - 0.5 * wrong) / n)
  }
}

/** 只读任务：汇总表列全候选、不列非候选；动了写工具直接 0 */
export function auditCompletion(world: PatrolWorld, hostTools: ReadonlySet<string>) {
  const candidates = new Set(world.candidates.map((c) => c.campaignId))
  const known = new Set(world.campaigns.map((c) => c.campaignId))
  return (o: EvalOutcomeDraft): number => {
    const wrote = o.fresh.some(
      (e) => isCall(e) && (e.payload.name === "ads_campaigns_status" || e.payload.name === "commands_resume"),
    )
    if (wrote) return 0
    const ids = [...idsIn(reportTextOf(o.fresh, hostTools))]
    const listed = ids.filter((id) => candidates.has(id)).length
    const falsePositives = ids.filter((id) => known.has(id) && !candidates.has(id)).length
    return clamp01((listed - 0.5 * falsePositives) / candidates.size)
  }
}

// ---- 种子：真实第一次 run 的历史 ----

/** 第二条 user 消息之前的一切，去掉脑子留下的说明（perception / pin）与上一次的账单（budget_usage），seq 重排 */
export function seedOf(recording: readonly Event[]): Event[] {
  const second = recording.findIndex((e, i) => i > 0 && e.type === "core.user_message")
  const head = second < 0 ? recording : recording.slice(0, second)
  return head
    .filter((e) => {
      if (e.type === "core.budget_usage") return false
      if (e.type === "core.system_note") {
        const kind = (e as CoreEventOf<"core.system_note">).payload.kind
        return kind !== "perception" && kind !== "pin"
      }
      return true
    })
    .map((e, i) => ({ ...e, seq: i + 1 }))
}

// ---- 系统提示：dogfood 里的角色约定 + AdRate 两份 Skill 的要点（不带全文，三个臂一样） ----

export const PATROL_SYSTEM_PROMPT = `你是 AdRate（TikTok 广告投放工具）的运营助手，替 Owner 完成需要很多步的广告账户操作。
工作方式：
- 只通过给你的工具操作 AdRate；每个工具返回 AdRate 的 JSON 信封，只有 ok === true 才算成功，不要拿上游 code === 0 当成功。
- 写操作（改状态等）会先经 Owner 审批再执行；被拒绝就换方案或如实汇报，不要重复提交同一意图。
- 幂等键由系统按每次调用自动生成并随结果返回；exitCode 4/5 时用返回的 idempotencyKey 走 commands_get / commands_resume 对账，绝不换键重发。
- 遇到 RATE_LIMITED / RESOURCE_BUSY 用 wait_seconds 等 Retry-After 再试，设定有限次数；DAILY_QUOTA_EXCEEDED 立即停止并汇报。写操作每分钟限 10 次。
- 分页要按 meta.pagination（page / pageSize / totalNumber / totalPage）读到需要为止，不要凭一页下结论；报表里 null 是 N/A 不是 0。
- Command 返回 isFinal=true 且 status=succeeded 才算终态；isFinal=false 才值得有限次轮询。
- 长任务中要紧的中间结论（候选清单、已确认的 Command 终态、待办）要留住，完成后给 Owner 一张简明汇总表。
- 用中文向 Owner 汇报，简短直接。`

// ---- 装配 ----

export interface AdratePatrolOptions {
  /** 缩窗口让整理机制出手；缺省 64k（真实 run 结束时约 100k，固定开销另计） */
  contextWindow?: number
  maxTurns?: number
  maxResumes?: number
}

export interface AdratePatrolSuite {
  world: PatrolWorld
  tools: PatrolTools
  fixtures: EvalFixture[]
}

export function adratePatrolFixtures(opts: AdratePatrolOptions = {}): AdratePatrolSuite {
  const recording = loadRecording()
  const world = worldOf(recording)
  const tools = patrolTools(world)
  const facts = patrolFacts(world)
  const c = patrolConstraints(world)
  const hostTools = new Set(tools.all.map((t) => t.name))
  const common = {
    contextWindow: opts.contextWindow ?? 64_000,
    maxTurns: opts.maxTurns ?? 60,
    maxResumes: opts.maxResumes ?? 2,
  }
  const n = world.candidates.length
  const fixtures: EvalFixture[] = [
    {
      id: "adrate-patrol-disable",
      description: `巡检降本全流程：${world.campaigns.length} 条计划分页读完 → ${n} 条候选逐条复核 → 停投 → Command 终态 → 汇总表`,
      task: { input: world.taskInput, systemPrompt: PATROL_SYSTEM_PROMPT },
      tools: tools.all,
      facts,
      constraints: [c.onlyAdvertiser, c.disableOnlyCandidates],
      completion: disableCompletion(world, hostTools),
      ...common,
    },
    {
      id: "adrate-patrol-audit",
      description: `只读巡检：找出 ${n} 条候选并汇报，不许写`,
      task: {
        input: `广告主 ${world.advertiserId} 巡检：拉最近 30 天（${world.window.startDate} 到 ${world.window.endDate}）的计划报表，分页读完不要漏；结合计划列表找出当前状态为 ENABLE 但这 30 天花费为 0 的计划；对每个候选用 ads_campaigns_get 取最新状态确认仍是 ENABLE。这次只汇报、不要停投：给我一张表（计划 ID、名称、30 天花费、当前状态）。`,
        systemPrompt: PATROL_SYSTEM_PROMPT,
      },
      tools: tools.readOnly,
      facts: facts.filter((f) => f.id !== "write-limit"),
      constraints: [c.onlyAdvertiser, c.readOnly],
      completion: auditCompletion(world, hostTools),
      ...common,
    },
    {
      id: "adrate-patrol-resume",
      description: `接续版：种子 = 真实第一次 run（读完、复核完、${n} 个停投被参数 bug 拒绝、模型对账汇报），任务 = "工具修好了，继续"`,
      task: { input: world.resumeInput, systemPrompt: PATROL_SYSTEM_PROMPT, seed: seedOf(recording) },
      tools: tools.all,
      facts,
      constraints: [c.onlyAdvertiser, c.disableOnlyCandidates],
      completion: disableCompletion(world, hostTools),
      ...common,
      maxTurns: opts.maxTurns ?? 40,
    },
  ]
  return { world, tools, fixtures }
}
