/**
 * 停止语义与中断不重放（2026-11-05，AdRate 建议 1 / 2）。
 *
 * "补齐 pending"这条路原先不分 pending 是怎么来的：用户点了停止、执行途中进程死亡，下一个 run 一开头都会把调用再跑一遍。
 * 对改用户广告的写工具，重复执行就是重复花钱。这里放三件纯东西，循环与 asTool 共用：
 *
 * - `RunStop` / `isStopReason`：停止是中止的一种原因。宿主 `controller.abort(new RunStop())`，循环在暂停时把 pending 收尾成
 *   "没执行"等结果，下一个 run 直接问模型；其它中止原因（丢租约、断线）照旧留 pending、恢复时补跑。
 * - `isReplayable`：调用开始动手后中断了，能不能再跑一遍。缺省口径与 approval 的 byRisk 一致：只有 `risk: "low"` 的算可重放。
 * - `startedToolCallIds` / `toolStartedAt`：时间线里已经开始动手的调用（`core.tool_started`）及其开始时间。
 * - `outcomeUnknownText` / `withStartedAt`："结果未知"缀上调用开始时间（2026-11-09，AdRate 建议 10）。
 *
 * 模型可见的文案在 2026-11-05 用 DeepSeek 与 Claude 实测过（spikes/stop-and-interrupt；"中断"口径两句同日 DeepSeek 补测），改字前先复跑。
 */
import type { Event } from "../events/base.js"
import type { CoreEvent } from "../events/core.js"
import type { Tool } from "./types.js"

/** 用户停止时 paused(host) 的 interruption note */
export const STOPPED_NOTE = "stopped by the user"

/** 用户停止：调用还没开始 */
export const STOPPED_NOT_EXECUTED_TEXT =
  "Not executed: the run was stopped by the user before this call started."

/** 用户停止：可重放的调用（子代理）做了一半 */
export const STOPPED_IN_PROGRESS_TEXT =
  "Interrupted: the run was stopped by the user while this call was in progress; it may have partly taken effect."

/** 宿主收尾遗留调用（`RunStop("host")`，如 asTool 开新一轮前）：调用还没开始。不说"用户停止"——多半是进程中途死亡留下的 */
export const INTERRUPTED_NOT_EXECUTED_TEXT =
  "Not executed: an earlier run was interrupted before this call started."

/** 宿主收尾遗留调用：可重放的调用（子代理）做了一半 */
export const INTERRUPTED_IN_PROGRESS_TEXT =
  "Interrupted: an earlier run was interrupted while this call was in progress; it may have partly taken effect."

/** 不可重放的调用开始动手后中断，没留下结果：上游可能已经生效 */
export const OUTCOME_UNKNOWN_TEXT =
  "Execution was interrupted before a result was recorded; the outcome is unknown. Check the current state before retrying."

/**
 * 停止。作为 `AbortController.abort(reason)` 的 reason 传入：`controller.abort(new RunStop())`。
 * 判据只看 `name`（`isStopReason`），宿主装了两份 core 时 `instanceof` 会失效。
 *
 * `by` 决定模型读到的收尾文案（`stopTextsOf`）：缺省 `"user"`，用户点了停止；`"host"` 是宿主替自己收尾遗留调用
 * （asTool 开新一轮前清理子会话），多半是进程中途死亡留下的，不能对模型说"用户停止"
 */
export class RunStop extends Error {
  readonly by: "user" | "host"
  constructor(by: "user" | "host" = "user") {
    super(
      by === "user" ? "the run was stopped by the user" : "the host closed calls left by an interrupted run",
    )
    this.name = "RunStop"
    this.by = by
  }
}

/** 停止收尾的三处模型 / 宿主可见文字：pending 没开始、可重放的做了一半、paused 的 interruption note */
export interface StopTexts {
  notExecuted: string
  inProgress: string
  note: string
}

/**
 * 按停止原因取收尾文字（真源索引）。只有 `by === "host"` 换成"中断"口径，其余（含别的 core 副本造的、没有 `by` 的）一律按用户停止。
 * "结果未知"（`OUTCOME_UNKNOWN_TEXT`）两种口径通用，不在这里
 */
export function stopTextsOf(reason: unknown): StopTexts {
  return (reason as { by?: unknown } | null)?.by === "host"
    ? {
        notExecuted: INTERRUPTED_NOT_EXECUTED_TEXT,
        inProgress: INTERRUPTED_IN_PROGRESS_TEXT,
        note: "closed calls left by an interrupted run",
      }
    : { notExecuted: STOPPED_NOT_EXECUTED_TEXT, inProgress: STOPPED_IN_PROGRESS_TEXT, note: STOPPED_NOTE }
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
  return new Set(toolStartedAt(timeline).keys())
}

/**
 * 时间线里已经开始动手的调用 → 其 `core.tool_started` 的 `at`（循环时钟，毫秒）；同一调用若有多条 started，取第一条。
 * 注意：只有不可重放的调用 started 写在 execute 之前、`at` 才是开始时间；可重放的（子代理）是返回 subagentPause 后补写的，
 * `at` 是暂停时刻。拿它当开始时间对外说只能经 `outcomeUnknownText`
 */
export function toolStartedAt(timeline: Iterable<Event>): Map<string, number> {
  const started = new Map<string, number>()
  for (const raw of timeline) {
    const e = raw as CoreEvent
    if (e.type === "core.tool_started" && !started.has(e.payload.toolCallId))
      started.set(e.payload.toolCallId, e.at)
  }
  return started
}

/**
 * 给收尾文案句末缀上调用开始时间（AdRate 建议 10）。纯拼接，不判断 `at` 是不是真的开始时间——那是 `outcomeUnknownText` 的事。
 *
 * 缀在句末：常量仍是实际文案的逐字前缀，宿主按 `startsWith` 判断不受影响。时间用 `toISOString()` 原样（UTC、毫秒）；
 * `at` 缺失或超出 Date 可表示范围时原样返回——没有锚点就不编一个，也不能因此让收尾抛错
 */
export function withStartedAt(text: string, at: number | undefined): string {
  if (at === undefined) return text
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return text
  return `${text} This call started at ${date.toISOString()}.`
}

/**
 * "结果未知"的完整文案（真源索引）：runLoop 三处与 TanStack 适配器两处只经这里。
 *
 * 模型"先查再定"时要在查回的业务对象里认出哪条是这次调用产生的；参数相同的旧对象只能靠创建时间区分，而模型看不到事件的 `at`。
 * 只在工具已知且不可重放时缀时间：这时 started 写在 execute 之前，`at` 才是开始时间。工具不在表里时 started 可能是子代理
 * 暂停后补写的（`at` 是暂停时刻，比它建出的对象还晚），说错的锚点会让模型把这次建出的对象当成旧的、再做一遍，宁可不给。
 * 同理"做了一半"两句（只落给可重放的调用）不缀
 */
export function outcomeUnknownText(tool: Tool | undefined, startedAt: number | undefined): string {
  return tool !== undefined && !isReplayable(tool)
    ? withStartedAt(OUTCOME_UNKNOWN_TEXT, startedAt)
    : OUTCOME_UNKNOWN_TEXT
}
