/**
 * 回放（技术方案 §4 "审计回放（原样）"）：只凭事件日志，重算出每一轮模型请求时它看到了什么。
 *
 * 依据是两条既有事实：
 * 1. 投影是纯函数（§8）：同一份日志前缀 + 同样的参数 → 逐字相同的可见事件。
 * 2. 循环每轮都在请求前把"模型即将看到的一切"先写进日志（beforeModel 注入、阈值 compaction 都是先 append 再问模型）。
 * 所以"第 n 轮模型看到的" = project(该轮第一条模型输出之前的全部事件)。run-loop.test 里"日志可完整回放"钉死了这一点。
 *
 * 用途：审计界面（examples/minimal/replay.ts）、eval 的逐轮对比（M2 E1）、排查"模型当时为什么这么做"。
 *
 * 轮边界按**模型输出类型**（model_thinking / model_text / tool_call）判，不按 actor：脑子模块在工具执行期间
 * 留下的事件（模型自决的 compaction、模型钉的 pin、memory_op）actor 也是 model，并行工具时它们会落在
 * 某条 tool_result 之后，按 actor 切会被误当成一个新的模型轮（E1 修）。
 *
 * 边界（如实声明）：
 * - Socket 在 beforeModel 里直接替换投影（patch.events）的部分无法重算，回放给出的是缺省路径的结果；
 *   脑子模块新造的事件（system_note、compaction）都在日志里，不受影响。
 * - 请求发出但一条模型输出都没回来（降级层异常、provider 报错）的那一轮没有模型事件，识别不出请求边界，
 *   只在时间线上留一条 core.error；这类失败轮不计入 turns。
 */
import type { Event } from "../events/base.js"
import type { BudgetUsagePayload, CoreEventOf } from "../events/core.js"
import type { EventSchemaRegistry } from "../events/registry.js"
import { project } from "../projection/project.js"
import type { ProjectionStats, ProjectionStrategy, TokenEstimator } from "../projection/types.js"

export interface ReplayedTurn {
  /** 从 1 起 */
  index: number
  /** 请求发出时日志的末尾 seq。模型看到的 = timeline[seq ≤ requestAtSeq] 的投影 */
  requestAtSeq: number
  /** 模型这一轮看到的事件（按当时的顺序） */
  visible: Event[]
  stats: ProjectionStats
  /**
   * 重算投影时策略又新造了事件（如阈值 compaction）—— 当时并没有发生这件事，说明现在的策略或估算与当时不同。
   * 为 true 时 visible 是"按现在的规则会看到什么"，不是当时的事实。
   */
  diverged: boolean
  /** 模型这一轮的输出：thinking / text / tool_call，连续一段 */
  output: Event[]
  /** 输出之后、下一轮请求之前发生的事：工具结果、用量、暂停、审批…… */
  aftermath: Event[]
  /** 循环记的这一轮真实用量（core.budget_usage），没有则缺省 */
  usage?: BudgetUsagePayload
}

export interface ReplayResult {
  turns: ReplayedTurn[]
  /** 第一轮请求之前的事件（通常是用户的第一句话） */
  preamble: Event[]
}

export interface ReplayOptions {
  /** 与当时循环相同的预算：contextLimit 取模型的 contextWindow */
  budget: { contextLimit: number; reserveTokens?: number }
  /** 与当时循环相同的策略链；缺省 defaultProjectionChain() */
  strategies?: readonly ProjectionStrategy[]
  estimate?: TokenEstimator
  registry?: EventSchemaRegistry
}

const MODEL_OUTPUT_TYPES: ReadonlySet<string> = new Set([
  "core.model_thinking",
  "core.model_text",
  "core.tool_call",
])

/** 是否为模型这一轮的直接输出（降级层吐出的三种事件）。与投影裁剪切轮（splitTurns）同口径 */
export function isModelOutput(e: Event): boolean {
  return MODEL_OUTPUT_TYPES.has(e.type)
}

/**
 * 把一条时间线切成若干"模型轮"。时间线须按 seq 升序、同一会话（日志读出来就是这样）。
 * 请求边界 = 一条模型输出事件紧跟在非输出事件之后（或位于时间线开头）。
 */
export function replayTurns(timeline: readonly Event[], opts: ReplayOptions): ReplayResult {
  const sessionId = timeline[0]?.sessionId
  const turns: ReplayedTurn[] = []
  const preamble: Event[] = []

  let i = 0
  // 第一轮之前
  while (i < timeline.length && !isModelOutput(timeline[i] as Event)) preamble.push(timeline[i++] as Event)

  while (i < timeline.length) {
    const first = timeline[i] as Event
    const requestAtSeq = first.seq - 1
    const output: Event[] = []
    while (i < timeline.length && isModelOutput(timeline[i] as Event)) output.push(timeline[i++] as Event)
    const aftermath: Event[] = []
    while (i < timeline.length && !isModelOutput(timeline[i] as Event)) aftermath.push(timeline[i++] as Event)

    const prefix = timeline.slice(0, requestAtSeq)
    const projected = project({
      timeline: prefix,
      budget: opts.budget,
      // 回放不该产生新 id，也不依赖当前时间；给确定值让输出可比对
      now: first.at,
      newId: (at) => `replay-${at}-${requestAtSeq}`,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(opts.strategies ? { strategies: opts.strategies } : {}),
      ...(opts.estimate ? { estimate: opts.estimate } : {}),
      ...(opts.registry ? { registry: opts.registry } : {}),
    })
    const usage = aftermath.find(
      (e): e is CoreEventOf<"core.budget_usage"> => e.type === "core.budget_usage",
    )?.payload

    turns.push({
      index: turns.length + 1,
      requestAtSeq,
      visible: projected.events,
      stats: projected.stats,
      diverged: projected.emitted.length > 0,
      output,
      aftermath,
      ...(usage ? { usage } : {}),
    })
  }
  return { turns, preamble }
}
