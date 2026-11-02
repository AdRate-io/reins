/**
 * halt-on-failure —— 同批前一个调用失败时拦下后面的（2026-11-02，OnSet 建议 9）。
 *
 * 模型一次回复里排出的顺序往往就是先后关系（先 `board_update` 置待确认，再 `chat_send` 说"已交，请看"），
 * 但它结构上做不到"后一个以前一个的结果为条件"——一次回复里看不见结果。循环逐个执行，前一个失败后面照常执行，
 * 于是"状态没改成、通知已发出"。本模块是宿主给的边界（缺省不装）：同批排在前面的调用失败了、或还挂着
 * （等审批 / 等客户端回填 / 子代理暂停），后面的就以 block 落一条 isError 结果，说明原因、请模型处理完再调。
 * 调用顺序仍由模型排；被拦的调用 toolCallId 一一对应，历史完整（宪法一 / 二）。
 *
 * 判据只读 `ctx.batch`（循环随落随更，beforeTool 处理第 k 个调用时只看得见前面已落的结果），无状态、不进系统提示、不加工具。
 * 被拦的调用不执行、不计 `ctx.budget.toolCalls`（`budget_usage.toolCalls` 仍按模型发出的条数记）。
 *
 * 注册顺序：推荐放在最前——block 短路，后面的 Socket（approval 等）就看不到被拦的调用；不在最前也正确，只是前面的先看到。
 * TanStack 路径：适配器在 beforeTools 边界对整批一次性跑 beforeTool，那时同批都还没执行，本模块只看得见补跑时预置的失败
 * （刻意不对称清单）。
 */
import type { Socket, Tool, ToolCallEvent, ToolResultEvent } from "@reinsjs/core"
import { batchOf } from "../shared/batch.js"

export const HALT_ON_FAILURE_SOCKET_NAME = "halt-on-failure"

export interface HaltOnFailureOptions {
  /** 哪些失败结果算数（只会拿 isError 的结果来问）；缺省全算。例：只读查询失败不拦后续 */
  counts?: (result: ToolResultEvent) => boolean
  /** 哪些后续调用要拦；缺省全拦。例：`(_call, tool) => tool?.risk !== "low"`，让同批的只读查询、pin、recall 照跑 */
  applies?: (call: ToolCallEvent, tool: Tool | undefined) => boolean
  /** 告警出口（当前调用不在本批里——pending 跨批等罕见情形），每个原因只告一次。缺省 console.warn */
  warn?: (message: string) => void
}

/** 拦下时给模型的说明；`name` / `id` 是最初失败或挂起的那个调用（不是前一个被拦的） */
export function haltedText(name: string, id: string, why: "failed" | "waiting"): string {
  return why === "failed"
    ? `An earlier call in this batch (${name}, ${id}) failed, so this call was not run. Handle that first, then call again if still needed.`
    : `An earlier call in this batch (${name}, ${id}) is still waiting (for approval or a client result), so this call was not run. Once it has completed, call again if still needed.`
}

export function haltOnFailure(opts: HaltOnFailureOptions = {}): Socket {
  const counts = opts.counts ?? (() => true)
  const applies = opts.applies ?? (() => true)
  const warn = opts.warn ?? ((message: string) => console.warn(message))
  const warned = new Set<string>()

  return {
    name: HALT_ON_FAILURE_SOCKET_NAME,
    beforeTool(ctx, call, tool) {
      const batch = batchOf(ctx, "haltOnFailure")
      // 按 toolCallId 定位：前面的 Socket 可能 rewrite 出新的 call 对象
      const id = call.payload.toolCallId
      const at = batch.calls.findIndex((c) => c.payload.toolCallId === id)
      if (at < 0) {
        if (!warned.has("not-in-batch")) {
          warned.add("not-in-batch")
          warn(
            `haltOnFailure: call ${id} is not in the current batch (pending calls span batches?); not checked`,
          )
        }
        return undefined
      }
      if (!applies(call, tool)) return undefined
      const results = new Map(batch.results.map((r) => [r.payload.toolCallId, r]))
      const held = new Set(batch.held)
      // 从前往后找第一个：同批里被本模块拦下的调用本身也是 isError，点名它会误导，最初那个一定排在更前面
      for (const earlier of batch.calls.slice(0, at)) {
        const earlierId = earlier.payload.toolCallId
        const result = results.get(earlierId)
        if (result?.payload.isError && counts(result)) {
          return { block: haltedText(earlier.payload.name, earlierId, "failed") }
        }
        if (held.has(earlierId)) return { block: haltedText(earlier.payload.name, earlierId, "waiting") }
      }
      return undefined
    },
  }
}
