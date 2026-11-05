/**
 * 停止语义与中断不重放（2026-11-05，AdRate 建议 1 / 2）。
 *
 * "补齐 pending"这条路原先不分 pending 是怎么来的：用户点了停止、执行途中进程死亡，下一个 run 一开头都会把调用再跑一遍。
 * 对改用户广告的写工具，重复执行就是重复花钱。这里放三件纯东西，循环与 asTool 共用：
 *
 * - `RunStop` / `isStopReason`：停止是中止的一种原因。宿主 `controller.abort(new RunStop())`，循环在暂停时把 pending 收尾成
 *   "没执行"等结果，下一个 run 直接问模型；其它中止原因（丢租约、断线）照旧留 pending、恢复时补跑。
 * - `isReplayable`：调用开始动手后中断了，能不能再跑一遍。缺省口径与 approval 的 byRisk 一致：只有 `risk: "low"` 的算可重放。
 * - `startedToolCallIds`：时间线里已经开始动手的调用（`core.tool_started`）。
 *
 * 三句模型可见的文案在 2026-11-05 用 DeepSeek 与 Claude 实测过（spikes/stop-and-interrupt），改字前先复跑。
 */
import type { Event } from "../events/base.js"
import type { CoreEvent } from "../events/core.js"
import type { Tool } from "./types.js"

/** 用户停止：调用还没开始 */
export const STOPPED_NOT_EXECUTED_TEXT =
  "Not executed: the run was stopped by the user before this call started."

/** 用户停止：可重放的调用（子代理）做了一半 */
export const STOPPED_IN_PROGRESS_TEXT =
  "Interrupted: the run was stopped by the user while this call was in progress; it may have partly taken effect."

/** 不可重放的调用开始动手后中断，没留下结果：上游可能已经生效 */
export const OUTCOME_UNKNOWN_TEXT =
  "Execution was interrupted before a result was recorded; the outcome is unknown. Check the current state before retrying."

/**
 * 用户停止。作为 `AbortController.abort(reason)` 的 reason 传入：`controller.abort(new RunStop())`。
 * 判据只看 `name`（`isStopReason`），宿主装了两份 core 时 `instanceof` 会失效
 */
export class RunStop extends Error {
  constructor(message = "the run was stopped by the user") {
    super(message)
    this.name = "RunStop"
  }
}

/** 这个中止原因是不是用户停止（`signal.reason`）。按 name 判，跨 core 副本成立 */
export function isStopReason(reason: unknown): boolean {
  return typeof reason === "object" && reason !== null && (reason as { name?: unknown }).name === "RunStop"
}

/** signal 已中止且原因是用户停止 */
export function isStopped(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && isStopReason(signal.reason)
}

/**
 * 开始动手后中断的调用能不能再跑一遍（真源索引）：显式 `replayable` 优先，否则只有 `risk: "low"` 的可重放。
 * 没声明 risk 的算写工具、不重放——与 approval 缺省 byRisk 把它当要问人同一口径
 */
export function isReplayable(tool: Tool): boolean {
  return tool.replayable ?? tool.risk === "low"
}

/** 时间线里已经开始动手（有 `core.tool_started`）的 toolCallId */
export function startedToolCallIds(timeline: Iterable<Event>): Set<string> {
  const started = new Set<string>()
  for (const raw of timeline) {
    const e = raw as CoreEvent
    if (e.type === "core.tool_started") started.add(e.payload.toolCallId)
  }
  return started
}
