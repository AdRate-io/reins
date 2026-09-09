/**
 * 策略 5：预算裁剪 —— 模型没来得及自己整理、上下文仍然超限时的最后兜底（P1：框架动作只是兜底）。
 *
 * 做法：按"轮"从最旧的开始裁掉一个前缀，追加一条 compaction(decidedBy=threshold) 放在最前面，
 * 幸存的 pin 紧随其后。新造的 compaction 通过 emitted 交给循环 append，下一轮投影由折叠策略正常处理它。
 *
 * 切点必须满足三条，否则降级层会产出厂商拒收的请求：
 * 1. 只在轮边界切。assistant 轮 = 连续的 model_thinking / model_text / tool_call；其余连续事件为一轮。
 * 2. 保留部分的第一轮若含 tool_result，其 tool_call 必在被裁掉的轮里 → 这种切点不合法。
 * 3. seq 封闭：保留部分所有事件的 seq 都大于被裁部分的最大 seq，这样新 compaction 的 coversSeq
 *    是一个干净的区间，不会误伤保留的事件（折叠可能把旧 compaction 挪到前面，顺序与 seq 不一致）。
 *
 * 被裁掉的旧 compaction 摘要会原文并入新摘要，模型写过的整理不丢。
 */
import type { Event } from "../events/base.js"
import type { CoreEvent, CoreEventOf } from "../events/core.js"
import { createCoreEvent } from "../events/create.js"
import { estimateTotal } from "./estimate.js"
import { isCompaction, isPinNote, supersededIds } from "./fold.js"
import { foldedToolResults, renderFoldedToolResults } from "./manifest.js"
import type { ProjectionContext, ProjectionStrategy } from "./types.js"

const ASSISTANT_TYPES: ReadonlySet<string> = new Set([
  "core.model_thinking",
  "core.model_text",
  "core.tool_call",
])

/** 把事件序列切成轮：assistant 事件连成一轮，其余连成一轮 */
export function splitTurns(events: readonly Event[]): Event[][] {
  const turns: Event[][] = []
  let current: Event[] = []
  let currentIsAssistant: boolean | null = null
  for (const e of events) {
    const isAssistant = ASSISTANT_TYPES.has(e.type)
    if (currentIsAssistant !== null && isAssistant !== currentIsAssistant) {
      turns.push(current)
      current = []
    }
    current.push(e)
    currentIsAssistant = isAssistant
  }
  if (current.length > 0) turns.push(current)
  return turns
}

export type ThresholdSummarizer = (removed: readonly Event[], ctx: ProjectionContext) => string

export interface BudgetTruncateOptions {
  /** 与折叠策略一致：kind=pin 的 system_note 自动幸存；默认 true */
  autoKeepPinNotes?: boolean
  /** 生成兜底摘要的文本；默认给模型一段英文的机械描述 */
  summarize?: ThresholdSummarizer
}

/** 摘录文本片段，供机械摘要引用用户原话 */
function excerpt(parts: CoreEventOf<"core.user_message">["payload"]["content"], max = 120): string {
  const text = parts
    .map((p) => (p.type === "text" ? p.text : "[image]"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 默认兜底摘要：没有模型参与，只能机械描述 —— 说明发生了什么、被裁掉多少、并入旧摘要、引用用户原话开头。
 * 给模型看的默认文案用英文；宿主可整体替换。
 */
export const defaultThresholdSummary: ThresholdSummarizer = (removed, ctx) => {
  const prior = removed.filter(isCompaction)
  const fresh = removed.filter((e) => !isCompaction(e))
  const seqs = removed.map((e) => e.seq)
  const from = Math.min(...seqs, ...prior.map((c) => c.payload.coversSeq[0]))
  const to = Math.max(...seqs)

  const counts = new Map<string, number>()
  for (const e of fresh) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
  const countText = [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([type, n]) => `${n} ${type.replace(/^core\./, "")}`)
    .join(", ")

  const lines = [
    `[Context truncated by budget] Events seq ${from}-${to} were removed to fit the context window. ` +
      "They remain in the session log and can be recovered by the host if needed.",
  ]
  if (countText) lines.push(`Removed: ${countText}.`)
  if (prior.length > 0) {
    lines.push("Earlier summaries (preserved verbatim):")
    for (const c of prior) lines.push(`- ${c.payload.summary}`)
  }
  const users = fresh.filter((e): e is CoreEventOf<"core.user_message"> => e.type === "core.user_message")
  if (users.length > 0) {
    lines.push("User messages that were removed (openings only):")
    for (const u of users) lines.push(`- ${excerpt(u.payload.content)}`)
  }
  // E3c：列出被裁掉的工具结果，模型才知道有什么还能拿回来（取回工具由脑子提供，core 只报 seq）
  const manifest = renderFoldedToolResults(foldedToolResults(fresh, { lookup: ctx.timeline }), {
    heading: "Tool results that were removed (still in the session log, by seq):",
  })
  if (manifest) lines.push(manifest)
  return lines.join("\n")
}

/** 保留部分的第一轮不能含 tool_result（否则 tool_call 被裁成孤儿） */
function turnStartsCleanly(turn: readonly Event[]): boolean {
  return !turn.some((e) => e.type === "core.tool_result")
}

function maxSeq(events: readonly Event[]): number {
  let m = 0
  for (const e of events) if (e.seq > m) m = e.seq
  return m
}
function minSeq(events: readonly Event[]): number {
  let m = Number.POSITIVE_INFINITY
  for (const e of events) if (e.seq < m) m = e.seq
  return m
}

export function budgetTruncate(opts: BudgetTruncateOptions = {}): ProjectionStrategy {
  const autoKeep = opts.autoKeepPinNotes ?? true
  const summarize = opts.summarize ?? defaultThresholdSummary
  return {
    name: "budget-truncate",
    apply(events, ctx) {
      const target = ctx.budget.contextLimit - ctx.budget.reserveTokens
      const total = estimateTotal(events, ctx.estimate)
      if (total <= target) return { events: [...events] }

      const turns = splitTurns(events)
      // 候选：保留 turns[k..]，k 从 1 起（至少裁一轮），到 turns.length-1（至少留最后一轮）
      let chosen: number | null = null
      let lastValid: number | null = null
      let removedTokens = 0
      for (let k = 1; k < turns.length; k++) {
        removedTokens += estimateTotal(turns[k - 1] ?? [], ctx.estimate)
        const kept = turns.slice(k).flat()
        const removed = turns.slice(0, k).flat()
        const firstKept = turns[k]
        if (!firstKept || !turnStartsCleanly(firstKept)) continue
        if (minSeq(kept) <= maxSeq(removed)) continue
        lastValid = k
        const { survivors, summaryTokens } = plan(removed, ctx, autoKeep, summarize)
        if (total - removedTokens + summaryTokens + estimateTotal(survivors, ctx.estimate) <= target) {
          chosen = k
          break
        }
      }
      // 没有任何满足预算的切点：能裁多少裁多少，剩下的交给上层告警（stats.overBudget）
      const k = chosen ?? lastValid
      if (k === null) return { events: [...events] }

      const removed = turns.slice(0, k).flat()
      const kept = turns.slice(k).flat()
      const { survivors, compaction } = plan(removed, ctx, autoKeep, summarize)
      return { events: [compaction, ...survivors, ...kept], emitted: [compaction] }
    },
  }
}

/** 给定要裁掉的前缀，算出幸存者与新 compaction 事件。折叠与裁剪对"幸存"的定义一致（含"被取代者不幸存"） */
function plan(
  removed: readonly Event[],
  ctx: ProjectionContext,
  autoKeep: boolean,
  summarize: ThresholdSummarizer,
) {
  const priorCompactions = removed.filter(isCompaction)
  const superseded = supersededIds(ctx.timeline)
  const survivors = removed.filter(
    (e) =>
      !isCompaction(e) &&
      !superseded.has(e.id) &&
      ((autoKeep && isPinNote(e)) || priorCompactions.some((c) => c.payload.pinsKept.includes(e.id))),
  )
  const from = Math.min(minSeq(removed), ...priorCompactions.map((c) => c.payload.coversSeq[0]))
  const to = maxSeq(removed)
  const compaction: CoreEvent = createCoreEvent(ctx.registry, {
    type: "core.compaction",
    sessionId: ctx.sessionId,
    seq: ctx.nextSeq(),
    actor: "system",
    at: ctx.now,
    id: ctx.newId(ctx.now),
    payload: {
      coversSeq: [from, to],
      summary: summarize(removed, ctx),
      decidedBy: "threshold",
      pinsKept: survivors.map((e) => e.id),
    },
  })
  return { survivors, compaction, summaryTokens: ctx.estimate(compaction) }
}
