/**
 * 映射表：一条完整的时间线事件 → 零到多条 AG-UI 事件。纯函数，无状态；流式增量的状态在 encoder.ts。
 *
 * | reins 事件            | AG-UI                                                                 |
 * | --------------------- | --------------------------------------------------------------------- |
 * | user_message          | TEXT_MESSAGE_START(user) → CONTENT → END                              |
 * | model_text            | TEXT_MESSAGE_START(assistant) → CONTENT → END                         |
 * | model_thinking        | REASONING_START → REASONING_MESSAGE_START → CONTENT → MESSAGE_END → REASONING_END（无正文时只有首尾） |
 * | tool_call             | TOOL_CALL_START → TOOL_CALL_ARGS（整段 JSON）→ TOOL_CALL_END           |
 * | tool_result           | TOOL_CALL_RESULT（isError 与 spilled 放 metadata）                      |
 * | 其余 core.* 与 ext.*  | CUSTOM，name = 事件 type，value = 事件本身（审批弹窗、感知、预算等都在这里） |
 *
 * 内容片段只有文本能进 AG-UI 的消息正文；图片以占位文本代替并在 metadata.reins.dropped 里声明（P7：有损必声明）。
 */
import type { ContentPart, CoreEventPayloads, CoreEventType, Event } from "@reins/core"
import type { AguiEvent, AguiEventType, ReinsMetadata } from "./types.js"

/** 每种事件会翻成哪些 AG-UI 事件类型（按顺序）；测试据此逐条核对 */
export const AGUI_MAPPING: Record<CoreEventType | "ext.*", readonly AguiEventType[]> = {
  "core.user_message": ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"],
  "core.model_text": ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"],
  "core.model_thinking": [
    "REASONING_START",
    "REASONING_MESSAGE_START",
    "REASONING_MESSAGE_CONTENT",
    "REASONING_MESSAGE_END",
    "REASONING_END",
  ],
  "core.tool_call": ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"],
  "core.tool_result": ["TOOL_CALL_RESULT"],
  "core.system_note": ["CUSTOM"],
  "core.approval_request": ["CUSTOM"],
  "core.approval_decision": ["CUSTOM"],
  "core.compaction": ["CUSTOM"],
  "core.handoff": ["CUSTOM"],
  "core.memory_op": ["CUSTOM"],
  "core.budget_usage": ["CUSTOM"],
  "core.run_paused": ["CUSTOM"],
  "core.run_resumed": ["CUSTOM"],
  "core.error": ["CUSTOM"],
  "ext.*": ["CUSTOM"],
}

export interface MapContext {
  /** 本轮 assistant 文本消息的 id，tool_call 用它做 parentMessageId */
  parentMessageId?: string
}

/** 内容片段 → 一段文本。非文本片段以占位符代替并记入 dropped */
export function partsToText(parts: readonly ContentPart[]): { text: string; dropped: string[] } {
  const dropped: string[] = []
  const text = parts
    .map((p) => {
      if (p.type === "text") return p.text
      dropped.push(`image:${p.mime}`)
      return `[图片 ${p.mime}]`
    })
    .join("\n")
  return { text, dropped }
}

export function reinsMetadata(event: Event, dropped: string[] = []): { metadata: { reins: ReinsMetadata } } {
  const reins: ReinsMetadata = { seq: event.seq, eventId: event.id, type: event.type }
  if (dropped.length > 0) reins.dropped = dropped
  return { metadata: { reins } }
}

type P<T extends CoreEventType> = CoreEventPayloads[T]

export function mapEvent(event: Event, ctx: MapContext = {}): AguiEvent[] {
  const timestamp = event.at
  const meta = (dropped: string[] = []) => ({ timestamp, ...reinsMetadata(event, dropped) })

  switch (event.type) {
    case "core.user_message":
    case "core.model_text": {
      const role = event.type === "core.user_message" ? "user" : "assistant"
      const { text, dropped } =
        event.type === "core.user_message"
          ? partsToText((event.payload as P<"core.user_message">).content)
          : { text: (event.payload as P<"core.model_text">).text, dropped: [] }
      const messageId = event.id
      const out: AguiEvent[] = [{ type: "TEXT_MESSAGE_START", messageId, role, ...meta(dropped) }]
      if (text.length > 0) out.push({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: text, ...meta() })
      out.push({ type: "TEXT_MESSAGE_END", messageId, ...meta() })
      return out
    }
    case "core.model_thinking": {
      const { text } = event.payload as P<"core.model_thinking">
      const messageId = event.id
      const out: AguiEvent[] = [{ type: "REASONING_START", messageId, ...meta() }]
      // 加密 reasoning 只有 replay 没有正文：不造空消息，首尾事件让前端知道"这里想过"
      if (text.length > 0) {
        out.push(
          { type: "REASONING_MESSAGE_START", messageId, role: "reasoning", ...meta() },
          { type: "REASONING_MESSAGE_CONTENT", messageId, delta: text, ...meta() },
          { type: "REASONING_MESSAGE_END", messageId, ...meta() },
        )
      }
      out.push({ type: "REASONING_END", messageId, ...meta() })
      return out
    }
    case "core.tool_call": {
      const { toolCallId, name, args } = event.payload as P<"core.tool_call">
      return [
        {
          type: "TOOL_CALL_START",
          toolCallId,
          toolCallName: name,
          ...(ctx.parentMessageId !== undefined ? { parentMessageId: ctx.parentMessageId } : {}),
          ...meta(),
        },
        { type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify(args ?? {}), ...meta() },
        { type: "TOOL_CALL_END", toolCallId, ...meta() },
      ]
    }
    case "core.tool_result": {
      const { toolCallId, content, isError, spilled } = event.payload as P<"core.tool_result">
      const { text, dropped } = partsToText(content)
      const m = meta(dropped)
      // isError / spilled 是 reins 特有信息，AG-UI 结果事件没有对应字段，放 metadata 不丢
      const reins = { ...m.metadata.reins, isError, ...(spilled !== undefined ? { spilled } : {}) }
      return [
        {
          type: "TOOL_CALL_RESULT",
          messageId: event.id,
          toolCallId,
          content: text,
          role: "tool",
          timestamp,
          metadata: { reins },
        },
      ]
    }
    default:
      // 运维与脑子事件：原样交给前端，name 就是事件 type（core.approval_request 等），前端按需弹窗或忽略
      return [{ type: "CUSTOM", name: event.type, value: event, ...meta() }]
  }
}
