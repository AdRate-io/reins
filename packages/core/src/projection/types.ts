/**
 * 投影（技术方案 §8）：输入完整时间线，输出模型本轮应看到的事件。
 *
 * 投影是纯函数：同一份时间线快照、同样的参数，输出必须逐字相同。这让它可单测、可回放、
 * 可在 eval 里对比不同策略。任何"随机"（事件 id）与"时间"（at）都从 ctx 注入，不在策略里 Date.now()。
 *
 * 策略链按顺序执行，每个策略拿到上一步的结果与不变的上下文，输出新的事件序列。
 * 策略可以新造事件（如阈值兜底的 compaction），但必须通过 `emitted` 交出去由循环 append 进日志，
 * 否则违反"模型可见 ⟺ 已记录"。
 */
import type { Event } from "../events/base.js"
import type { EventSchemaRegistry } from "../events/registry.js"

export interface ProjectionBudget {
  /** 模型上下文窗口上限（token） */
  contextLimit: number
  /** 为模型输出与工具定义预留的 token；裁剪目标 = contextLimit - reserveTokens */
  reserveTokens: number
}

/** 估算一条事件降级后大约占多少 token。核心包不带 tokenizer，默认是粗估，宿主可注入精确实现。 */
export type TokenEstimator = (event: Event) => number

/** 策略执行时能看到的一切。全部只读；策略之间不共享可变状态。 */
export interface ProjectionContext {
  readonly sessionId: string
  /** 完整时间线快照，按 seq 升序。策略要回看被前序策略移除的事件时用 */
  readonly timeline: readonly Event[]
  readonly budget: ProjectionBudget
  readonly estimate: TokenEstimator
  /** 新造事件取 schemaVersion 用 */
  readonly registry: EventSchemaRegistry
  /** 本次投影的时间戳；新造事件的 at 一律取它 */
  readonly now: number
  /** 新造事件的 id 工厂；测试可注入确定值 */
  readonly newId: (at: number) => string
  /** 前序策略已新造、待 append 的事件 */
  readonly emitted: readonly Event[]
  /** 下一条新造事件应使用的 seq：时间线末尾 + 已新造数 + 1 */
  nextSeq(): number
}

export interface ProjectionStep {
  /** 本策略之后模型应看到的事件序列。顺序即模型看到的顺序，不必与 seq 一致 */
  events: Event[]
  /**
   * 本策略新造、需要由循环 append 进日志的事件。
   * 必须同时出现在 events 里 —— 模型看到的每一条都要落日志。
   */
  emitted?: Event[]
}

export interface ProjectionStrategy {
  readonly name: string
  apply(events: readonly Event[], ctx: ProjectionContext): ProjectionStep
}

export interface ProjectionStepStats {
  name: string
  /** 进入该策略前 / 后的事件数 */
  before: number
  after: number
}

export interface ProjectionStats {
  /** 最终可见事件的估算 token 总量 */
  estimatedTokens: number
  /** contextLimit - reserveTokens */
  targetTokens: number
  /** 裁到不能再裁仍超目标：只剩最后一轮也放不下，需要 spill 或更大的窗口。循环层据此告警 */
  overBudget: boolean
  steps: ProjectionStepStats[]
}

export interface ProjectionResult {
  /** 模型本轮看到的事件 */
  events: Event[]
  /** 投影新造、循环必须 append 进日志的事件（seq 已按时间线末尾预分配；冲突则重跑投影） */
  emitted: Event[]
  stats: ProjectionStats
}
