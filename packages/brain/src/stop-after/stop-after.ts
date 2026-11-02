/**
 * stop-after —— 调成功某个工具，本轮结束即停（2026-11-02，OnSet 建议 10）。
 *
 * "交差即停"：分支的 `fork_done`、主会话的 `end_run({ note })` 把最后一批动作和收尾放在同一次回复里，
 * 本轮结束 run 就以 done 收场，省掉"做完再请求一轮写收尾文字"那一轮。是不是收尾由模型决定（调不调这个工具），
 * 本模块只兑现（宪法一）。工具本身（把 note 当最后发言等）归宿主。
 *
 * `onTurnEnd` 返回 "stop" 的条件全部成立：
 * 1. 本批（`ctx.batch`）里有名单工具的成功结果（以真正落日志的那条为准，afterTool 替换之后）；
 * 2. 同批没有 isError 结果、没有挂起的、每个调用都有结果——同批有失败就让模型下一轮看到再决定；
 * 3. 补跑轮（续跑补齐上次遗留的调用）另要求本批之后时间线上没有新的用户消息：
 *    `[action 需审批, end_run]` 批准续跑、无新输入时照样收尾（与 handoff 从日志重建意图同理）；
 *    但遗留的收尾不能吞掉新 run 带来的新输入。
 *
 * 注册顺序：onTurnEnd 第一个给意见的说了算。推荐 handoff → stopAfter → compact / budget：
 * 排在 handoff 前会让 `[handoff, end_run]` 吞掉交接——模型已收到"Handoff scheduled"，框架却不兑现；
 * 排在 budget 后则触顶的那轮会以暂停收场而不是收尾。
 * 与 compact：模型在被请整理的那轮直接收尾，run 以 done 结束，那一级请求已用掉，下一个 run 不再请（阈值兜底仍在）。
 */
import type { CoreEvent, Socket } from "@reinsjs/core"
import { batchOf } from "../shared/batch.js"

export const STOP_AFTER_SOCKET_NAME = "stop-after"

export interface StopAfterOptions {
  /** 调成功即收尾的工具名 */
  tools: readonly string[]
  /** 告警出口（名单里的工具不在本轮工具表——多半是拼错），每个名字只告一次。缺省 console.warn */
  warn?: (message: string) => void
}

export function stopAfter(opts: StopAfterOptions): Socket {
  const names = opts.tools as unknown
  if (!Array.isArray(names) || names.length === 0) {
    throw new RangeError(
      `stopAfter.tools must be a non-empty array of tool names, got ${JSON.stringify(names)}`,
    )
  }
  for (const n of names) {
    if (typeof n !== "string" || n.length === 0) {
      throw new RangeError(`stopAfter.tools must contain non-empty strings, got ${JSON.stringify(n)}`)
    }
  }
  const stopping = new Set<string>(names as string[])
  const warn = opts.warn ?? ((message: string) => console.warn(message))
  const warned = new Set<string>()

  return {
    name: STOP_AFTER_SOCKET_NAME,
    beforeModel(ctx) {
      // 对照本轮工具表（不用 SocketSetup.tools：它看不到注册在本 Socket 之后的贡献）
      for (const name of stopping) {
        if (warned.has(name) || ctx.tools.some((t) => t.name === name)) continue
        warned.add(name)
        warn(`stopAfter: tool "${name}" is not in this run's tool list; it can never end a turn`)
      }
      return undefined
    },
    onTurnEnd(ctx) {
      const batch = batchOf(ctx, "stopAfter")
      if (batch.calls.length === 0 || batch.held.length > 0) return undefined
      const answered = new Set(batch.results.map((r) => r.payload.toolCallId))
      if (!batch.calls.every((c) => answered.has(c.payload.toolCallId))) return undefined
      if (batch.results.some((r) => r.payload.isError)) return undefined
      if (!batch.results.some((r) => stopping.has(r.payload.name))) return undefined
      if (batch.resumed) {
        const lastCallSeq = Math.max(...batch.calls.map((c) => c.seq))
        const newInput = ctx.timeline.some(
          (e) => e.seq > lastCallSeq && (e as CoreEvent).type === "core.user_message",
        )
        if (newInput) return undefined
      }
      return "stop"
    },
  }
}
