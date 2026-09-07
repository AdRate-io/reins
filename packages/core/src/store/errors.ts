export type StoreErrorCode =
  | "seq_conflict" // seq 不连续或与已有事件冲突（并发写入者）
  | "session_mismatch" // 一批 append 混了多个会话
  | "empty_batch" // append 了空数组
  | "not_found" // blob 不存在
  | "target_not_empty" // fork 目标会话已有事件
  | "out_of_range" // fork 的 atSeq 超出源会话范围
  | "invalid_argument" // 其他参数问题（如 tail 的 n < 0）

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${message}`)
    this.name = "StoreError"
  }
}
