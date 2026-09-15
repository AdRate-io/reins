/**
 * 策略链执行器与默认链。
 *
 * 默认链（技术方案 §8）：过滤 → 折叠 → 钉住 → 预算裁剪。
 * 感知注入（§9.1）不在这条链上：它是 `@reinsjs/brain` 的 Socket，在 beforeModel 里把 system_note 作为新事件
 * 追加到时间线末尾（prompt cache 约束：只追加、不改前缀）。投影只负责"看历史"，不负责"说话"。
 */
import type { Event } from "../events/base.js"
import { uuidv7 } from "../events/id.js"
import { createCoreRegistry, type EventSchemaRegistry } from "../events/registry.js"
import { estimateTotal, roughTokenEstimate } from "./estimate.js"
import { type VisibilityFilterOptions, visibilityFilter } from "./filter.js"
import { type FoldOptions, foldCompactions } from "./fold.js"
import { reinjectPins } from "./pins.js"
import { type BudgetTruncateOptions, budgetTruncate } from "./truncate.js"
import type {
  ProjectionContext,
  ProjectionResult,
  ProjectionStepStats,
  ProjectionStrategy,
  TokenEstimator,
} from "./types.js"

/** 未指定 reserveTokens 时，为输出与工具定义预留窗口的这个比例 */
export const DEFAULT_RESERVE_RATIO = 0.15

export interface DefaultChainOptions {
  filter?: VisibilityFilterOptions
  fold?: FoldOptions
  truncate?: BudgetTruncateOptions
}

export function defaultProjectionChain(opts: DefaultChainOptions = {}): ProjectionStrategy[] {
  return [
    visibilityFilter(opts.filter),
    foldCompactions(opts.fold),
    reinjectPins(),
    budgetTruncate({ autoKeepPinNotes: opts.fold?.autoKeepPinNotes ?? true, ...opts.truncate }),
  ]
}

export interface ProjectOptions {
  /** 完整时间线快照，按 seq 升序、同一会话 */
  timeline: readonly Event[]
  budget: { contextLimit: number; reserveTokens?: number }
  /** 缺省 defaultProjectionChain() */
  strategies?: readonly ProjectionStrategy[]
  /** 缺省 roughTokenEstimate */
  estimate?: TokenEstimator
  /** 缺省内置 core 注册表；宿主有 ext.* 事件时传自己的 */
  registry?: EventSchemaRegistry
  /** 缺省时间线里最后一条的 sessionId；空时间线必须显式给 */
  sessionId?: string
  /** 缺省 Date.now()；测试注入以获得确定输出 */
  now?: number
  /** 缺省 uuidv7；测试注入以获得确定输出 */
  newId?: (at: number) => string
}

let defaultRegistry: EventSchemaRegistry | undefined
/** 内置注册表只在首次需要时构造一次；project() 本身不持有别的状态 */
function coreRegistry(): EventSchemaRegistry {
  if (!defaultRegistry) defaultRegistry = createCoreRegistry()
  return defaultRegistry
}

/**
 * 跑一遍策略链。除 now / newId 外没有任何外部输入，同一参数必得同一输出。
 * 时间线必须按 seq 严格升序，否则说明调用方拼错了快照，直接拒绝而不是产出错误的投影。
 */
export function project(opts: ProjectOptions): ProjectionResult {
  const { timeline } = opts
  for (let i = 1; i < timeline.length; i++) {
    const prev = timeline[i - 1]
    const cur = timeline[i]
    if (prev && cur && cur.seq <= prev.seq) {
      throw new RangeError(
        `projection input must be strictly ascending by seq: seq ${cur.seq} at index ${i} is not greater than the previous ${prev.seq}`,
      )
    }
  }
  const last = timeline[timeline.length - 1]
  const sessionId = opts.sessionId ?? last?.sessionId
  if (sessionId === undefined) throw new RangeError("an empty timeline requires an explicit sessionId")

  const reserveTokens =
    opts.budget.reserveTokens ?? Math.floor(opts.budget.contextLimit * DEFAULT_RESERVE_RATIO)
  const budget = { contextLimit: opts.budget.contextLimit, reserveTokens }
  const estimate = opts.estimate ?? roughTokenEstimate
  const registry = opts.registry ?? coreRegistry()
  const now = opts.now ?? Date.now()
  const newId = opts.newId ?? uuidv7
  const strategies = opts.strategies ?? defaultProjectionChain()

  let events: Event[] = [...timeline]
  const emitted: Event[] = []
  const steps: ProjectionStepStats[] = []
  const lastSeq = last?.seq ?? 0

  for (const strategy of strategies) {
    const ctx: ProjectionContext = {
      sessionId,
      timeline,
      budget,
      estimate,
      registry,
      now,
      newId,
      emitted: [...emitted],
      nextSeq: () => lastSeq + emitted.length + 1,
    }
    const before = events.length
    const step = strategy.apply(events, ctx)
    events = step.events
    if (step.emitted) emitted.push(...step.emitted)
    steps.push({ name: strategy.name, before, after: events.length })
  }

  const estimatedTokens = estimateTotal(events, estimate)
  const targetTokens = budget.contextLimit - budget.reserveTokens
  return {
    events,
    emitted,
    stats: { estimatedTokens, targetTokens, overBudget: estimatedTokens > targetTokens, steps },
  }
}
