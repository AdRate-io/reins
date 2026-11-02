/**
 * 工具批的定位（2026-11-02，OnSet 建议 9 / 10）。
 *
 * "一批" = 一段连续模型输出里的 tool_call。与 replay 切轮（`isModelOutput`）同口径，另外跳过模型不可见的运维事件
 * （budget_usage、approval_request、run_paused…）——它们可能夹在同一次输出中间（TanStack 的 onUsage 早于输出收尾时），
 * 与 lowering-fetch IR"运维事件不打断 assistant 分组"同一条规矩。runLoop 与 TanStack 适配器补跑时都调它（真源索引）。
 */
import type { Event } from "../events/base.js"
import type { CoreEvent } from "../events/core.js"
import { DEFAULT_MODEL_INVISIBLE_TYPES } from "../projection/filter.js"
import { isModelOutput } from "../replay/replay.js"
import type { ToolCallEvent, ToolResultEvent } from "./types.js"

/** 同一批里可以连续出现的事件：模型输出，或模型不可见的运维事件 */
function inBatchSpan(e: Event): boolean {
  return isModelOutput(e) || DEFAULT_MODEL_INVISIBLE_TYPES.has(e.type)
}

/**
 * 遗留调用所在的那批：以第一条 pending 为锚，前后扩到不属于同一段的事件为止，收其中的 tool_call；
 * 并按时间线顺序收这些调用已落的 tool_result（上次 run 已执行的、宿主经 input 回填的）。
 * pending 跨多批（fork、混用两种循环才会出现）时只取第一批——其余 pending 照样会被执行，只是不在 `calls` 里。
 * 纯函数；`pending` 为空返回空批
 */
export function toolBatchOf(
  timeline: readonly Event[],
  pending: readonly ToolCallEvent[],
): { calls: ToolCallEvent[]; results: ToolResultEvent[] } {
  const anchor = pending[0]
  if (!anchor) return { calls: [], results: [] }
  const at = timeline.findIndex((e) => e.id === anchor.id)
  if (at < 0) return { calls: [...pending], results: [] }
  let start = at
  while (start > 0 && inBatchSpan(timeline[start - 1] as Event)) start--
  let end = at
  while (end + 1 < timeline.length && inBatchSpan(timeline[end + 1] as Event)) end++
  const calls: ToolCallEvent[] = []
  for (let i = start; i <= end; i++) {
    const e = timeline[i] as CoreEvent
    if (e.type === "core.tool_call") calls.push(e as ToolCallEvent)
  }
  const ids = new Set(calls.map((c) => c.payload.toolCallId))
  const results: ToolResultEvent[] = []
  for (const raw of timeline) {
    const e = raw as CoreEvent
    if (e.type === "core.tool_result" && ids.has(e.payload.toolCallId)) results.push(e as ToolResultEvent)
  }
  return { calls, results }
}
