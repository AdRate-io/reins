/**
 * 策略 1：可见性过滤。
 *
 * 只做"给不给模型看"，不改事件内容。trust 标注（不可信内容加显式标记）不在这里做：
 * 事件已带 trust 字段，降级层翻译成文本时按它包裹，这样投影不必复制事件、不篡改 payload。
 */
import type { Event } from "../events/base.js"
import type { ProjectionStrategy } from "./types.js"

/**
 * 默认对模型不可见的运维事件。它们服务于宿主与审计，对模型没有信息量或已由别的事件承载：
 * - approval_*：审批结果由 B7 以 tool_result(isError) 告知模型
 * - run_paused / run_resumed / budget_usage / memory_op：运行记录，感知模块会把要点提炼进 system_note
 * - handoff：交接后当前会话结束，新会话首条 user 消息承载 triggerMessage
 * - error：provider 级错误由循环层处理；工具错误已在 tool_result.isError
 * - tools_bound：每次 run 起步的工具表快照（P1）；工具表本身在请求里，增删由循环以 system_note(kind=host) 告知模型
 */
export const DEFAULT_MODEL_INVISIBLE_TYPES: ReadonlySet<string> = new Set([
  "core.approval_request",
  "core.approval_decision",
  "core.run_paused",
  "core.run_resumed",
  "core.budget_usage",
  "core.memory_op",
  "core.handoff",
  "core.error",
  "core.tools_bound",
])

export interface VisibilityFilterOptions {
  /** 覆盖默认的不可见类型集合 */
  invisibleTypes?: Iterable<string>
  /** 额外判定，返回 false 即不可见。宿主放 principal 可见性等规则 */
  isVisible?: (event: Event) => boolean
}

export function visibilityFilter(opts: VisibilityFilterOptions = {}): ProjectionStrategy {
  const invisible = opts.invisibleTypes ? new Set(opts.invisibleTypes) : DEFAULT_MODEL_INVISIBLE_TYPES
  const extra = opts.isVisible
  return {
    name: "visibility-filter",
    apply(events) {
      return { events: events.filter((e) => !invisible.has(e.type) && (extra ? extra(e) : true)) }
    },
  }
}
