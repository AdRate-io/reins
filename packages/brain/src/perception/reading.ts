/**
 * 从本轮上下文算出感知读数（技术方案 §9.1 列的几项）。纯函数：同一 TurnContext 同一读数。
 *
 * 数据来源刻意区分两处：
 * - `ctx.events`（模型本轮将看到的投影）：算"未折叠历史有多长"、"有几条外溢结果可取"—— 这些是模型视角的量；
 * - `ctx.timeline`（完整日志）：算"整理过几次"、"本会话累计花了多少 token"—— 这些是会话全局的量。
 */
import { type CoreEvent, contextTokensOf, type Event, type TurnContext } from "@reins/core"
import type { BudgetDimension, BudgetLimits } from "../budget/budget.js"
import { compactNumber, countTier, percent, rangeTier, type Tier } from "./tiers.js"

/** 预算上限：与 budget 模块（§9.8）同一个形状，宿主把同一份 limits 传给两个模块。给了哪几维就只按那几维算余量 */
export type PerceptionLimits = BudgetLimits

export type LimitDimension = BudgetDimension

export interface PerceptionReading {
  /** 上下文窗口使用率档位（校准后的本轮上下文估算 / contextLimit，见 contextOverheadOf） */
  contextUsage: Tier
  /**
   * 校准用的固定开销（token）：上一次请求的真实上下文 − 当时的投影估算，即系统提示、工具表、thinking 等估算不含的部分。
   * 没有可对照的请求时为 0。精确值，只进 meta 不进文字
   */
  contextOverhead: number
  /** 阈值兜底的触发点（裁剪目标 / contextLimit），如 "85%"。配置不变它就不变 */
  autoFoldAt: string
  /** 当前可见、未被折叠的模型轮数档位（一轮 = 连续的 thinking / text / tool_call） */
  unfoldedTurns: Tier
  /** 本会话至今的整理次数（模型自决 + 阈值兜底）。只在整理时变，而整理本身已经改了前缀 */
  compactions: number
  /** 本会话累计消耗 token（输入 + 缓存读写 + 输出，按 budget_usage 事件累加）档位 */
  sessionTokens: Tier
  /** 可见的外溢工具结果条数档位；level 0 即没有 */
  spilledResults: Tier
  /** 配置了上限时：最紧的那一维的剩余比例档位 */
  budgetRemaining?: Tier & { tightest: LimitDimension }
}

export interface ReadingThresholds {
  usage: readonly number[]
  turns: readonly number[]
  tokens: readonly number[]
  spills: readonly number[]
  remaining: readonly number[]
}

const ASSISTANT_TYPES: ReadonlySet<string> = new Set([
  "core.model_thinking",
  "core.model_text",
  "core.tool_call",
])

/** 与投影裁剪同一口径：连续的模型输出算一轮 */
export function countModelTurns(events: readonly Event[]): number {
  let turns = 0
  let inTurn = false
  for (const e of events) {
    const isAssistant = ASSISTANT_TYPES.has(e.type)
    if (isAssistant && !inTurn) turns++
    inTurn = isAssistant
  }
  return turns
}

/** 累加 budget_usage：输入、缓存读、缓存写、输出全算，反映的是"花了多少"，不是"上下文多大" */
export function sumSessionTokens(timeline: readonly Event[]): number {
  let n = 0
  for (const raw of timeline) {
    const e = raw as CoreEvent
    if (e.type !== "core.budget_usage") continue
    const t = e.payload.tokens
    n += t.input + t.output + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0)
  }
  return n
}

/**
 * 估算与真实之间的固定开销（B8，关闭 §17 的 B2 实测发现）。
 *
 * 投影只数模型可见事件的正文，系统提示、工具表、thinking 签名块等都不在内，真实 input 可高出一倍。
 * 这些多出来的部分在一个 run 里基本是常量（系统提示与工具表整轮不变），所以用**加法**校准而不是比例：
 * 比例会随历史变长把误差放大（100k 时翻倍成 200k），加法只补那块固定的开销。
 * 数据来自日志最后一条同时带 tokens 与 contextEstimate 的 budget_usage：真实上下文 = input + cacheRead + cacheWrite。
 */
export function contextOverheadOf(timeline: readonly Event[]): number {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i] as CoreEvent | undefined
    if (e?.type !== "core.budget_usage" || e.payload.contextEstimate === undefined) continue
    return Math.max(0, contextTokensOf(e.payload.tokens) - e.payload.contextEstimate)
  }
  return 0
}

function remainingOf(
  budget: TurnContext["budget"],
  contextTokens: number,
  limits: PerceptionLimits,
): { fraction: number; dimension: LimitDimension } | undefined {
  const used: Record<LimitDimension, number> = {
    contextTokens,
    totalTokens: budget.tokensSpent,
    turns: budget.turns,
    toolCalls: budget.toolCalls,
    wallMs: budget.wallMs,
  }
  let tightest: { fraction: number; dimension: LimitDimension } | undefined
  for (const dimension of Object.keys(used) as LimitDimension[]) {
    const limit = limits[dimension]
    if (limit === undefined || limit <= 0) continue
    const fraction = Math.max(0, 1 - used[dimension] / limit)
    if (!tightest || fraction < tightest.fraction) tightest = { fraction, dimension }
  }
  return tightest
}

export interface ReadingOptions {
  /** 用上一请求的真实用量校准上下文估算。缺省 true；关掉则只按投影估算（偏低） */
  calibrate?: boolean
}

export function readPerception(
  ctx: TurnContext,
  thresholds: ReadingThresholds,
  limits?: PerceptionLimits,
  opts: ReadingOptions = {},
): PerceptionReading {
  const { budget } = ctx
  const contextOverhead = opts.calibrate === false ? 0 : contextOverheadOf(ctx.timeline)
  const contextTokens = budget.used + contextOverhead
  const spilled = ctx.events.filter(
    (e) => e.type === "core.tool_result" && (e as CoreEvent & { type: "core.tool_result" }).payload.spilled,
  ).length
  const spilledTier = spillTier(spilled, thresholds.spills)
  const reading: PerceptionReading = {
    contextUsage: rangeTier(contextTokens / budget.contextLimit, thresholds.usage, percent),
    contextOverhead,
    autoFoldAt: percent(budget.targetTokens / budget.contextLimit),
    unfoldedTurns: countTier(countModelTurns(ctx.events), thresholds.turns),
    compactions: ctx.timeline.filter((e) => e.type === "core.compaction").length,
    sessionTokens: rangeTier(sumSessionTokens(ctx.timeline), thresholds.tokens, compactNumber),
    spilledResults: spilledTier,
  }
  const remaining = limits ? remainingOf(budget, contextTokens, limits) : undefined
  if (remaining) {
    reading.budgetRemaining = {
      ...rangeTier(remaining.fraction, thresholds.remaining, percent),
      tightest: remaining.dimension,
    }
  }
  return reading
}

/** 外溢档位：0 单独占 level 0（"没有"与"有几条"对模型是两回事），其余按计数档位整体后移一档 */
function spillTier(n: number, bounds: readonly number[]): Tier {
  if (n === 0) return { level: 0, label: "0" }
  const t = countTier(n, bounds)
  const first = bounds[0]
  // 计数档位的首档标签是 "≤b0"，这里 0 已单列，首档实际是 1–b0
  const label = t.level === 0 && first !== undefined ? (first === 1 ? "1" : `1–${first}`) : t.label
  return { level: t.level + 1, label }
}
