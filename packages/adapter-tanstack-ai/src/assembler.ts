/**
 * 把 TanStack 的流式 AG-UI chunk 拼成完整内容块的事件草稿（对应降级层"草稿只在内容块完整时产出"的约定）。
 *
 * 文本：TEXT_MESSAGE_START/CONTENT/END → model_text（END 时产出）。
 * 思考：REASONING_* 的正文累积，签名可能在 REASONING_ENCRYPTED_VALUE(subtype=message) 或 STEP_FINISHED.signature 里、
 *      且可能排在 REASONING_MESSAGE_END 之后，所以思考块在遇到下一个非思考 chunk（文本 / 工具调用 / 收尾）时才产出。
 * 工具调用：TOOL_CALL_START/ARGS/END → tool_call（END 时产出，入参按 JSON 解析，解析不了原样存字符串）；
 *      REASONING_ENCRYPTED_VALUE(subtype=tool-call) 是 Gemini 类的 thoughtSignature，写进 replay。
 * replay 记 { provider, api, model }（与 lowering-pi 同字段），回放时据此判断签名能否复用。
 */
import type { EventDraft } from "@reinsjs/core"
import type { StreamChunk } from "@tanstack/ai"
import { parseArgs } from "./messages.js"

export interface AssemblerOrigin {
  provider: string
  api: string
  model: string
}

interface PendingText {
  text: string
}
interface PendingThinking {
  text: string
  signature?: string
}
interface PendingCall {
  name: string
  args: string
  input?: unknown
  thoughtSignature?: string
}

export class BlockAssembler {
  private text: PendingText | undefined
  private thinking: PendingThinking | undefined
  private readonly calls = new Map<string, PendingCall>()
  /** 工具调用结束前先到的 thoughtSignature */
  private readonly callSignatures = new Map<string, string>()

  constructor(private readonly origin: AssemblerOrigin) {}

  /** 新一次模型响应开始前清空半成品（上一轮如有未收尾的块已由 finish 产出） */
  reset(): void {
    this.text = undefined
    this.thinking = undefined
    this.calls.clear()
    this.callSignatures.clear()
  }

  /** 喂一个 chunk，返回此刻完整了的块（0 或多条） */
  push(chunk: StreamChunk): EventDraft[] {
    const out: EventDraft[] = []
    const c = chunk as StreamChunk & Record<string, unknown>
    switch (chunk.type) {
      case "TEXT_MESSAGE_START":
        this.flushThinking(out)
        this.text = { text: "" }
        break
      case "TEXT_MESSAGE_CONTENT": {
        if (!this.text) this.text = { text: "" }
        // 部分适配器用 content 给全文（覆盖）而不是 delta（追加），与 TanStack 引擎同一处理
        if (typeof c.content === "string" && c.content !== "") this.text.text = c.content
        else if (typeof c.delta === "string") this.text.text += c.delta
        break
      }
      case "TEXT_MESSAGE_END":
        this.flushText(out)
        break

      case "REASONING_START":
      case "REASONING_MESSAGE_START":
        this.flushThinking(out)
        this.thinking = { text: "" }
        break
      case "REASONING_MESSAGE_CONTENT":
        if (!this.thinking) this.thinking = { text: "" }
        if (typeof c.delta === "string") this.thinking.text += c.delta
        break
      case "REASONING_MESSAGE_END":
      case "REASONING_END":
        break // 等签名
      case "REASONING_ENCRYPTED_VALUE": {
        const value = typeof c.encryptedValue === "string" ? c.encryptedValue : undefined
        if (value === undefined) break
        if (c.subtype === "tool-call" && typeof c.entityId === "string") {
          const call = this.calls.get(c.entityId)
          if (call) call.thoughtSignature = value
          else this.callSignatures.set(c.entityId, value)
        } else {
          if (!this.thinking) this.thinking = { text: "" }
          this.thinking.signature = value
        }
        break
      }
      case "STEP_STARTED":
        this.flushThinking(out)
        break
      case "STEP_FINISHED":
        if (typeof c.signature === "string" && c.signature !== "") {
          if (!this.thinking) this.thinking = { text: "" }
          this.thinking.signature = c.signature
        }
        break

      case "TOOL_CALL_START": {
        this.flushThinking(out)
        const id = String(c.toolCallId)
        const name = typeof c.toolCallName === "string" ? c.toolCallName : String(c.toolName ?? "")
        const call: PendingCall = { name, args: "" }
        const sig = this.callSignatures.get(id)
        if (sig !== undefined) {
          call.thoughtSignature = sig
          this.callSignatures.delete(id)
        }
        const meta = c.metadata as { thoughtSignature?: unknown } | undefined
        if (typeof meta?.thoughtSignature === "string") call.thoughtSignature = meta.thoughtSignature
        this.calls.set(id, call)
        break
      }
      case "TOOL_CALL_ARGS": {
        const call = this.calls.get(String(c.toolCallId))
        if (call && typeof c.delta === "string") call.args += c.delta
        break
      }
      case "TOOL_CALL_END": {
        const id = String(c.toolCallId)
        const call = this.calls.get(id)
        if (!call) break
        this.calls.delete(id)
        const args = c.input !== undefined ? c.input : parseArgs(call.args)
        const replay: Record<string, unknown> = { ...this.origin }
        if (call.thoughtSignature !== undefined) replay.thoughtSignature = call.thoughtSignature
        out.push({
          type: "core.tool_call",
          actor: "model",
          payload: { toolCallId: id, name: call.name, args },
          replay,
        })
        break
      }

      case "RUN_FINISHED":
      case "RUN_ERROR":
        out.push(...this.finish())
        break
      default:
        break
    }
    return out
  }

  /** 收尾：把还没产出的块都产出（没等到 END 的文本、等签名的思考、没等到 END 的工具调用） */
  finish(): EventDraft[] {
    const out: EventDraft[] = []
    this.flushThinking(out)
    this.flushText(out)
    for (const [id, call] of this.calls) {
      const replay: Record<string, unknown> = { ...this.origin }
      if (call.thoughtSignature !== undefined) replay.thoughtSignature = call.thoughtSignature
      out.push({
        type: "core.tool_call",
        actor: "model",
        payload: { toolCallId: id, name: call.name, args: parseArgs(call.args) },
        replay,
      })
    }
    this.calls.clear()
    this.callSignatures.clear()
    return out
  }

  private flushText(out: EventDraft[]): void {
    if (!this.text) return
    const { text } = this.text
    this.text = undefined
    if (text.length === 0) return
    out.push({ type: "core.model_text", actor: "model", payload: { text }, replay: { ...this.origin } })
  }

  private flushThinking(out: EventDraft[]): void {
    if (!this.thinking) return
    const { text, signature } = this.thinking
    this.thinking = undefined
    if (text.length === 0 && signature === undefined) return
    const replay: Record<string, unknown> = { ...this.origin }
    if (signature !== undefined) replay.thinkingSignature = signature
    out.push({ type: "core.model_thinking", actor: "model", payload: { text }, replay })
  }
}
