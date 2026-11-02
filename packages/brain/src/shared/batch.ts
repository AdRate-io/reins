/**
 * halt-on-failure 与 stop-after 共用：取 ctx.batch，缺了就说清楚为什么。
 *
 * `TurnContext.batch` 是 core 0.8.0 起的必填字段；宿主装出两份 core（自己复制的旧 runLoop + brain 带的新 core）时
 * 运行时会是 undefined——与其在 `ctx.batch.calls` 上炸成 TypeError，不如直接点名缺什么。
 */
import type { ToolBatch, TurnContext } from "@reinsjs/core"

export function batchOf(ctx: TurnContext, module: string): ToolBatch {
  const batch = (ctx as { batch?: ToolBatch }).batch
  if (batch === undefined) {
    throw new Error(`${module} requires a loop that fills TurnContext.batch (@reinsjs/core >= 0.8.0)`)
  }
  return batch
}
