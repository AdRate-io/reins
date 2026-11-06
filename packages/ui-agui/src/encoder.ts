/**
 * AG-UI 编码器：给 @reinsjs/server 的 `encode` 用，把一条 SSE 流翻成 AG-UI 事件流。
 *
 *   start            → RUN_STARTED（threadId = 会话 id，runId = 本条流）
 *   event            → mapEvent（见 map-event.ts）
 *   delta(text)      → 第一片就 TEXT_MESSAGE_START + CONTENT，之后逐片 CONTENT；完整 model_text 到达时只补 END
 *   delta(thinking)  → 同上，用 REASONING_* 五件套
 *   delta(tool_args) → 丢弃：增量里没有 toolCallId 与工具名，凑不出 TOOL_CALL_START；完整 tool_call 到达时一次给出
 *   result / end     → RUN_FINISHED（done / handoff → success；paused → interrupt，interrupts 一一对应 Interruption）
 *   error            → RUN_ERROR
 *
 * 有状态的只有"流过增量、还没被完整事件认领的内容块"：增量先到、完整事件后到，两者要接成同一条消息。
 * 降级层一律在整次响应流完后才交出草稿（思考 → 正文 → 工具调用），所以同一轮的思考块与正文块会同时处于打开状态：
 * 换块时不收尾，完整 model_thinking / model_text 到达时认领**内容对得上**的最早同 kind 块，补带 metadata.reins 的 END。
 * 对不上（redacted 思考的占位正文、上游没给草稿的块）就不认领、整段照发：宁可重复，不丢内容。
 * AG-UI 按 id 分别跟踪进行中的消息，允许多块同时打开，只要求 RUN_FINISHED 前全部收尾（@ag-ui/client 1.0.3 verify）。
 * 由增量开出的消息 id 是临时生成的（增量里没有事件 id）；不带增量的补发路径直接用事件 id。
 * SSE 的 `id:`（= seq）只挂在一个时间线事件翻出的最后一帧上，这样 Last-Event-ID 永远指向已完整送达的事件。
 */
import type { Event, LoweringDelta, RunResult } from "@reinsjs/core"
import { uuidv7 } from "@reinsjs/core"
import type { SseFrame, StreamEncoder, StreamEncoderFactory, StreamItem } from "@reinsjs/server"
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
  /** 已流出的增量拼起来的正文，认领时与完整事件比对 */
  text: string
}

/**
 * 增量拼出的正文与完整事件的正文是不是同一段。首尾空白不算：pi-ai 的 Responses 线在每段推理摘要后多发一个
 * "\n\n" 增量，收尾正文不带最后那个
 */
function sameText(streamed: string, committed: string): boolean {
  return streamed.trim() === committed.trim()
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

/** 一条流一个实例（有状态）。接 @reinsjs/server 请用 `aguiEncoding()`，它按流创建实例。 */
export function createAguiEncoder(options: AguiEncoderOptions = {}): StreamEncoder {
  const newRunId = options.newRunId ?? (() => uuidv7())
  const newMessageId = options.newMessageId ?? (() => uuidv7())
  let threadId = ""
  let runId = ""
  /** 流过增量、尚未被完整事件认领的块；键 `kind:index`，Map 的插入顺序即认领顺序 */
  const open = new Map<string, OpenBlock>()
  /** 本轮 assistant 文本的消息 id，给随后的 tool_call 做 parentMessageId；用户说话即重置 */
  let parentMessageId: string | undefined

  /** 一块的收尾帧；由完整事件认领时带 metadata.reins，无主收尾时不带 */
  const endOf = (block: OpenBlock, e?: Event): AguiEvent[] => {
    const meta = e ? { timestamp: e.at, metadata: metaOf(e) } : {}
    return block.kind === "text"
      ? [{ type: "TEXT_MESSAGE_END", messageId: block.messageId, ...meta }]
      : [
          { type: "REASONING_MESSAGE_END", messageId: block.messageId, ...meta },
          { type: "REASONING_END", messageId: block.messageId, ...meta },
        ]
  }

  /** 无主收尾所有打开的块：非模型输出的事件、run 结束时都不留半截（AG-UI 要求 RUN_FINISHED 前全部收尾） */
  const closeOpen = (): AguiEvent[] => {
    const out = [...open.values()].flatMap((b) => endOf(b))
    open.clear()
    return out
  }

  /** 取出最早打开、内容对得上的同 kind 块 */
  const claim = (kind: OpenBlock["kind"], text: string): OpenBlock | undefined => {
    for (const [key, block] of open) {
      if (block.kind !== kind || !sameText(block.text, text)) continue
      open.delete(key)
      return block
    }
    return undefined
  }

  const onDelta = (d: LoweringDelta): AguiEvent[] => {
    if (d.kind === "tool_args") return []
    if (d.delta.length === 0) return []
    const key = `${d.kind}:${d.index}`
    const cur = open.get(key)
    if (cur) {
      cur.text += d.delta
      return cur.kind === "text"
        ? [{ type: "TEXT_MESSAGE_CONTENT", messageId: cur.messageId, delta: d.delta }]
        : [{ type: "REASONING_MESSAGE_CONTENT", messageId: cur.messageId, delta: d.delta }]
    }
    // 换块不收尾前一块：它的完整事件要等整次响应流完才到，届时再认领（AdRate 建议 9）
    const out: AguiEvent[] = []
    const messageId = newMessageId()
    open.set(key, { kind: d.kind, index: d.index, messageId, text: d.delta })
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
    // 增量已经把这个块流完了：只补收尾，id 沿用增量开出的那个。
    // 按内容认领而不是按顺序：redacted 思考（正文是占位串）、加密思考（正文为空）都没流过增量，按顺序会抢走后面真流过的块
    const kind =
      e.type === "core.model_text" ? "text" : e.type === "core.model_thinking" ? "thinking" : undefined
    if (kind !== undefined) {
      const block = claim(kind, (e.payload as { text: string }).text)
      if (block) {
        if (kind === "text") parentMessageId = block.messageId
        return endOf(block, e)
      }
    }
    // 同一次响应的其它模型输出（工具调用、没流过的块）不打断仍待认领的块；其余事件先把半截块无主收尾
    const out = kind !== undefined || e.type === "core.tool_call" ? [] : closeOpen()
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
      // 补发结束：会话末尾是带状态的 run_paused 时 server 给出 state，原样放进 result 供客户端 resume（AdRate 建议 8）。
      // outcome 仍是 success 不是 interrupt：补发只有日志，拼不出 live result 的 interruptions，确认卡从补发里的 approval_request 画
      case "end":
        return frames([
          ...closeOpen(),
          {
            type: "RUN_FINISHED",
            threadId,
            runId,
            result: {
              status: "replayed",
              sessionId: item.sessionId,
              lastSeq: item.lastSeq,
              ...(item.state !== undefined ? { state: item.state } : {}),
            },
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
