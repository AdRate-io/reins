/**
 * AG-UI 协议事件（本包只用到的子集），形状按 @ag-ui/core 0.0.59 的 zod schema 手抄：
 * 运行时零依赖，测试里用官方 EventSchemas 逐条校验我们产出的每个事件（见 *.test.ts）。
 *
 * 只做翻译不发明：能用 AG-UI 原生事件表达的（文本、推理、工具调用与结果、run 生命周期）用原生；
 * reins 特有的（system_note、compaction、审批、预算、暂停恢复…）一律走 CUSTOM，name = 事件 type。
 */

export type AguiRole = "developer" | "system" | "assistant" | "user"

/** 每个事件都可带的字段。metadata.reins 记来源 seq / 事件 id，客户端据此去重或定位时间线 */
export interface AguiBaseFields {
  timestamp?: number
  metadata?: Record<string, unknown>
}

export interface AguiInterrupt {
  id: string
  reason: string
  message?: string
  toolCallId?: string
  metadata?: Record<string, unknown>
}

export type AguiRunOutcome = { type: "success" } | { type: "interrupt"; interrupts: AguiInterrupt[] }

export type AguiEvent = AguiBaseFields &
  (
    | { type: "RUN_STARTED"; threadId: string; runId: string }
    | { type: "RUN_FINISHED"; threadId: string; runId: string; result?: unknown; outcome?: AguiRunOutcome }
    | { type: "RUN_ERROR"; message: string; code?: string }
    | { type: "TEXT_MESSAGE_START"; messageId: string; role: AguiRole }
    | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
    | { type: "TEXT_MESSAGE_END"; messageId: string }
    | { type: "REASONING_START"; messageId: string }
    | { type: "REASONING_MESSAGE_START"; messageId: string; role: "reasoning" }
    | { type: "REASONING_MESSAGE_CONTENT"; messageId: string; delta: string }
    | { type: "REASONING_MESSAGE_END"; messageId: string }
    | { type: "REASONING_END"; messageId: string }
    | { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string; parentMessageId?: string }
    | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
    | { type: "TOOL_CALL_END"; toolCallId: string }
    | { type: "TOOL_CALL_RESULT"; messageId: string; toolCallId: string; content: string; role?: "tool" }
    | { type: "CUSTOM"; name: string; value: unknown }
  )

export type AguiEventType = AguiEvent["type"]

/** 挂在每个由时间线事件翻译出来的 AG-UI 事件上：它来自哪条日志 */
export interface ReinsMetadata {
  seq: number
  eventId: string
  type: string
  /** 翻译有损时列出丢了什么（如图片内容片段），不静默 */
  dropped?: string[]
}
