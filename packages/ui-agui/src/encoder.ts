/**
 * AG-UI 编码器：给 @reins/server 的 `encode` 用，把一条 SSE 流翻成 AG-UI 事件流。
 *
 *   start            → RUN_STARTED（threadId = 会话 id，runId = 本条流）
 *   event            → mapEvent（见 map-event.ts）
 *   delta(text)      → 第一片就 TEXT_MESSAGE_START + CONTENT，之后逐片 CONTENT；完整 model_text 到达时只补 END
 *   delta(thinking)  → 同上，用 REASONING_* 五件套
 *   delta(tool_args) → 丢弃：增量里没有 toolCallId 与工具名，凑不出 TOOL_CALL_START；完整 tool_call 到达时一次给出
 *   result / end     → RUN_FINISHED（done / handoff → success；paused → interrupt，interrupts 一一对应 Interruption）
 *   error            → RUN_ERROR
 *
 * 有状态的只有"正在流的那个内容块"：增量先到、完整事件后到，两者要接成同一条消息。
 * 由增量开出的消息 id 是临时生成的（增量里没有事件 id）；不带增量的补发路径直接用事件 id。
 * SSE 的 `id:`（= seq）只挂在一个时间线事件翻出的最后一帧上，这样 Last-Event-ID 永远指向已完整送达的事件。
 */
import type { Event, LoweringDelta, RunResult } from "@reins/core"
import { uuidv7 } from "@reins/core"
import type { SseFrame, StreamEncoder, StreamEncoderFactory, StreamItem } from "@reins/server"
import { mapEvent } from "./map-event.js"
import type { AguiEvent, AguiInterrupt } from "./types.js"

export interface AguiEncoderOptions {
  /** 本条流的 runId；缺省 uuidv7 */
  newRunId?: () => string
  /** 增量开出的消息 id；缺省 uuidv7 */
  newMessageId?: () => string
}

interface OpenBlock {
  kind: "text" | "thinking"
  index: number
  messageId: string
}

function interruptsOf(result: Extract<RunResult, { status: "paused" }>): AguiInterrupt[] {
  return result.interruptions.map((i, n) => {
    switch (i.kind) {
      case "approval":
        return {
          id: i.toolCallId,
          reason: "approval",
          message: i.request.summary,
          toolCallId: i.toolCallId,
          metadata: { policyId: i.request.policyId, call: i.call },
        }
      case "client_tool":
        return {
          id: i.toolCallId,
          reason: "client_tool",
          toolCallId: i.toolCallId,
          metadata: { call: i.call },
        }
      case "subagent":
        // 子代理冒泡（§10.1）：子的中断嵌在 metadata 里，前端给子的审批答复时把 childSessionId 放进 decisions[].sessionId
        return {
          id: i.toolCallId,
          reason: "subagent",
          message: `subagent session ${i.childSessionId} paused (${i.reason})`,
          toolCallId: i.toolCallId,
          metadata: {
            call: i.call,
            childSessionId: i.childSessionId,
            childReason: i.reason,
            interruptions: i.interruptions,
            state: i.state,
          },
        }
      default:
        return { id: `${i.kind}:${result.lastSeq}:${n}`, reason: i.kind, message: i.note }
    }
  })
}

/** 一条流一个实例（有状态）。接 @reins/server 请用 `aguiEncoding()`，它按流创建实例。 */
export function createAguiEncoder(options: AguiEncoderOptions = {}): StreamEncoder {
  const newRunId = options.newRunId ?? (() => uuidv7())
  const newMessageId = options.newMessageId ?? (() => uuidv7())
  let threadId = ""
  let runId = ""
  let open: OpenBlock | undefined
  /** 本轮 assistant 文本的消息 id，给随后的 tool_call 做 parentMessageId；用户说话即重置 */
  let parentMessageId: string | undefined

  /** 把正在流的块收尾（正常路径由对应的完整事件收尾；别的事件先到时也不留半截） */
  const closeOpen = (): AguiEvent[] => {
    if (!open) return []
    const { kind, messageId } = open
    open = undefined
    return kind === "text"
      ? [{ type: "TEXT_MESSAGE_END", messageId }]
      : [
          { type: "REASONING_MESSAGE_END", messageId },
          { type: "REASONING_END", messageId },
        ]
  }

  const onDelta = (d: LoweringDelta): AguiEvent[] => {
    if (d.kind === "tool_args") return []
    if (d.delta.length === 0) return []
    if (open && open.kind === d.kind && open.index === d.index) {
      return open.kind === "text"
        ? [{ type: "TEXT_MESSAGE_CONTENT", messageId: open.messageId, delta: d.delta }]
        : [{ type: "REASONING_MESSAGE_CONTENT", messageId: open.messageId, delta: d.delta }]
    }
    const out = closeOpen()
    const messageId = newMessageId()
    open = { kind: d.kind, index: d.index, messageId }
    if (d.kind === "text") {
      parentMessageId = messageId
      out.push(
        { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId, delta: d.delta },
      )
    } else {
      out.push(
        { type: "REASONING_START", messageId },
        { type: "REASONING_MESSAGE_START", messageId, role: "reasoning" },
        { type: "REASONING_MESSAGE_CONTENT", messageId, delta: d.delta },
      )
    }
    return out
  }

  const onEvent = (e: Event): AguiEvent[] => {
    // 增量已经把这个块流完了：只补收尾，id 沿用增量开出的那个
    if (open && e.type === "core.model_text" && open.kind === "text") {
      const { messageId } = open
      open = undefined
      return [{ type: "TEXT_MESSAGE_END", messageId, timestamp: e.at, metadata: metaOf(e) }]
    }
    if (open && e.type === "core.model_thinking" && open.kind === "thinking") {
      const { messageId } = open
      open = undefined
      return [
        { type: "REASONING_MESSAGE_END", messageId, timestamp: e.at, metadata: metaOf(e) },
        { type: "REASONING_END", messageId, timestamp: e.at, metadata: metaOf(e) },
      ]
    }
    const out = closeOpen()
    if (e.type === "core.user_message") parentMessageId = undefined
    if (e.type === "core.model_text") parentMessageId = e.id
    out.push(...mapEvent(e, parentMessageId !== undefined ? { parentMessageId } : {}))
    return out
  }

  const metaOf = (e: Event) => ({ reins: { seq: e.seq, eventId: e.id, type: e.type } })

  const frames = (events: AguiEvent[], seq?: number): SseFrame[] =>
    events.map((data, i) =>
      seq !== undefined && i === events.length - 1 ? { id: String(seq), data } : { data },
    )

  return (item: StreamItem): SseFrame[] => {
    switch (item.kind) {
      case "start":
        threadId = item.sessionId
        runId = newRunId()
        return frames([
          {
            type: "RUN_STARTED",
            threadId,
            runId,
            metadata: { reins: { fromSeq: item.fromSeq, live: item.live } },
          },
        ])
      case "event":
        return frames(onEvent(item.event), item.event.seq)
      case "delta":
        return frames(onDelta(item.delta))
      case "result": {
        const r = item.result
        if (r.status === "error") {
          return frames([
            ...closeOpen(),
            { type: "RUN_ERROR", message: r.error.payload.message, code: r.error.payload.category },
          ])
        }
        const outcome =
          r.status === "paused"
            ? { type: "interrupt" as const, interrupts: interruptsOf(r) }
            : { type: "success" as const }
        return frames([...closeOpen(), { type: "RUN_FINISHED", threadId, runId, result: r, outcome }])
      }
      case "end":
        return frames([
          ...closeOpen(),
          {
            type: "RUN_FINISHED",
            threadId,
            runId,
            result: { status: "replayed", sessionId: item.sessionId, lastSeq: item.lastSeq },
            outcome: { type: "success" },
          },
        ])
      case "error":
        return frames([...closeOpen(), { type: "RUN_ERROR", message: item.message, code: item.code }])
    }
  }
}

/**
 * 直接可用的 `encode` 选项：server 每开一条流调用一次，各流状态互不串。
 *
 *   createAgentHandler(agent, { encode: aguiEncoding() })
 */
export function aguiEncoding(options: AguiEncoderOptions = {}): StreamEncoderFactory {
  return () => createAguiEncoder(options)
}
