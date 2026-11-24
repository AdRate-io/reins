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
 * - run_paused / run_resumed：run 的起止记录，只给宿主判状态与续跑用；没有模块把它转述给模型
 *   （宿主想让模型知道上次为什么停，自己按 run_paused 的原因码写一条 system_note）
 * - budget_usage：用量记录，感知模块把要点提炼进 system_note
 * - memory_op：记忆读写的审计记录，模型已从工具结果得知
 * - handoff：交接后当前会话结束，新会话首条 user 消息承载 triggerMessage
 * - error：provider 级错误由循环层处理；工具错误已在 tool_result.isError
 * - tools_bound：每次 run 起步的工具表快照（P1）；工具表本身在请求里，增删由循环以 system_note(kind=host) 告知模型
 * - tool_started：调用已开始动手的标记，只给续跑与停止判断用；模型从 tool_result 得知结果
 * - run_ended：run 的终结记号（跑完 / 交接 / 出错），只给宿主判会话状态用
 *
 * 宿主扩展事件 `ext.*` 不在这张表里，但 visibilityFilter 缺省同样剔除：降级层对它没有通用落点（三条 fetch 线与 pi 版
 * 都记 dropped、不下发），留在视图里只会让估算、感知读数、兜底裁剪把模型看不到的字节算作上下文占用（全库审查 2026-11-25 #19）。
 * 宿主要让模型看见某条 ext.*，设 `keepExtEvents` 并在排在后面的自有策略里把它翻成 core 事件（system_note 等）
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
  "core.tool_started",
  "core.run_ended",
])

export interface VisibilityFilterOptions {
  /** 覆盖默认的不可见 core 类型集合（ext.* 另由 keepExtEvents 管，不受它影响） */
  invisibleTypes?: Iterable<string>
  /**
   * 缺省 false：ext.* 一律剔除。设 true 时留在视图里，交给排在后面的宿主策略翻成 core 事件——
   * 原样留到降级层仍是 dropped，且会计入估算
   */
  keepExtEvents?: boolean
  /** 额外判定，返回 false 即不可见。宿主放 principal 可见性等规则 */
  isVisible?: (event: Event) => boolean
}

export function visibilityFilter(opts: VisibilityFilterOptions = {}): ProjectionStrategy {
  const invisible = opts.invisibleTypes ? new Set(opts.invisibleTypes) : DEFAULT_MODEL_INVISIBLE_TYPES
  const extra = opts.isVisible
  const keepExt = opts.keepExtEvents === true
  return {
    name: "visibility-filter",
    apply(events) {
      return {
        events: events.filter(
          (e) =>
            !invisible.has(e.type) && (keepExt || !e.type.startsWith("ext.")) && (extra ? extra(e) : true),
        ),
      }
    },
  }
}
