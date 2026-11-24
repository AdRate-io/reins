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

/**
 * 前端展示用的内容片段（AdRate 建议 19）：**永不含字节**，与时间线 content 逐个对应、顺序相同。
 * 图片只有引用形态才带 `blobId`（前端拿它去宿主自己的鉴权路由取图）；内联图片、视频、音频只给 mime。
 * `blobId` 是不透明字符串：拼 URL 要 encodeURIComponent；取不到（内联、被保留策略清掉）时前端退回占位显示
 */
export type AguiDisplayPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; blobId?: string }
  | { type: "video"; mime: string }
  | { type: "audio"; mime: string }

/** 挂在每个由时间线事件翻译出来的 AG-UI 事件上：它来自哪条日志 */
export interface ReinsMetadata {
  seq: number
  eventId: string
  type: string
  /** 翻译有损时列出丢了什么（如图片内容片段），不静默 */
  dropped?: string[]
  /**
   * 展示片段。只在 `core.user_message` 的 TEXT_MESSAGE_START / END 与 TOOL_CALL_RESULT 上出现，
   * 且只在 content 含媒体片段时出现（与 `dropped` 同出同缺）。前端有它就按片段渲染，没有就照旧读正文
   */
  parts?: AguiDisplayPart[]
  /**
   * 事件来源（时间线的 `provenance` 原样）。**只在 `core.user_message` 的 TEXT_MESSAGE_START / END 上出现**
   * （两帧同带：AG-UI 客户端合并 metadata 时后写整个替换，只挂 START 会被 END 冲掉）：
   * server 进行中投递的送达判据是 `provenance.ref === deliveryId`，缺省 AG-UI 编码下客户端靠它对账。
   * 不扩到其余事件——tool_result 与脑子写的事件都带 provenance，全量带出会改变线上每条 TOOL_CALL_RESULT 的形状
   */
  provenance?: { source: string; ref?: string }
}
