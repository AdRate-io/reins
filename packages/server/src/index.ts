/**
 * @reinsjs/server —— 把 runLoop 装进 Web 标准 handler：`(Request) => Promise<Response>`。
 *
 * - POST 起 run，SSE 实时推时间线事件（`id:` = seq），结束给 result 帧（paused 时含可回传的 state）
 * - GET 带 lastSeq / Last-Event-ID 重连，从 EventLog 补发，撞上正在跑的 run 则继续实时推
 * - 编码可换：缺省原样推事件；AG-UI 编码器见 @reinsjs/ui-agui
 * - 零运行时私有依赖：Node / Bun / Workers / Deno 同一份代码
 */
export { createAgentHandler, DEFAULT_HEARTBEAT_MS, SESSION_HEADER } from "./handler.js"
export { ActiveRun, Channel, RunConflictError, RunRegistry, type RunSignal } from "./runs.js"
export { encodeSseFrame, rawEncoder, SSE_HEADERS, SSE_HEARTBEAT } from "./sse.js"
export type * from "./types.js"
