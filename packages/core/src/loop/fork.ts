/**
 * 会话分叉（T11）：从某个 seq 起复制出一条新会话，两边此后独立演进。
 *
 * 复制本身由 EventLog.fork 完成（保留 id 与 seq，只换 sessionId）。这里只做两件事：
 * 缺省生成新会话 id；提醒分叉点的语义 —— 若切在 tool_call 与 tool_result 之间，
 * 新会话首轮会把那次调用当作 pending 重新执行（这正是"独立演进"的含义，有副作用的工具请切在轮边界）。
 */
import { uuidv7 } from "../events/id.js"
import type { EventLog } from "../store/types.js"

export interface ForkOptions {
  fromSessionId: string
  /** 复制 [1, atSeq]，含 */
  atSeq: number
  /** 缺省 uuidv7 */
  toSessionId?: string
}

export async function forkSession(log: EventLog, opts: ForkOptions): Promise<{ toSessionId: string }> {
  const toSessionId = opts.toSessionId ?? uuidv7()
  await log.fork(opts.fromSessionId, opts.atSeq, toSessionId)
  return { toSessionId }
}
