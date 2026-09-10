/**
 * 子代理即工具（§10.1）的暂停标记：`asTool` 这类工具跑的子 run 暂停时，`execute` 返回 `subagentPause(detail)` 而不是结果，
 * 循环见到它不落 tool_result、把这次调用留作 pending，整个 run 以 `paused` 返回并把子的中断带给宿主（`SubagentInterruption`）。
 *
 * 为什么是返回值而不是抛错：暂停不是异常，抛出去会被 execute 的 catch 当成"工具执行失败"吞成 isError。
 * 品牌用 `Symbol.for`：宿主里装了两份 core 也认得。
 */
import type { SubagentInterruption } from "./types.js"

const SUBAGENT_PAUSE = Symbol.for("reins.subagentPause")

/** 工具要交给循环的部分：toolCallId 与 call 由循环补 */
export type SubagentPauseDetail = Omit<SubagentInterruption, "kind" | "toolCallId" | "call">

export interface SubagentPause {
  readonly [SUBAGENT_PAUSE]: true
  readonly detail: SubagentPauseDetail
}

export function subagentPause(detail: SubagentPauseDetail): SubagentPause {
  return { [SUBAGENT_PAUSE]: true, detail }
}

export function isSubagentPause(value: unknown): value is SubagentPause {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [SUBAGENT_PAUSE]?: unknown })[SUBAGENT_PAUSE] === true
  )
}
