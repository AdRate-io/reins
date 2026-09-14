/**
 * Anthropic Messages 流 → 事件草稿。
 *
 * 只在流收尾时按拼好的内容块产出草稿（signature 在 content_block_stop 前才齐），增量经 onDelta 给 UI。
 * 中断或出错时把已拼出的部分内容也交出去——日志要记录"发生过什么"，是否继续由循环决定。
 *
 * 事件形状（厂商 SSE，按 data.type 分派，不看 event: 行；F0 A7 实测）：
 *   message_start{ message: { id, model, usage: { input_tokens, cache_creation_input_tokens, cache_read_input_tokens } } }
 *   content_block_start{ index, content_block: text | thinking | redacted_thinking | tool_use }
 *   content_block_delta{ index, delta: text_delta | thinking_delta | signature_delta | input_json_delta }
 *   content_block_stop{ index }
 *   message_delta{ delta: { stop_reason, stop_sequence, stop_details? }, usage: { output_tokens, … } }
 *   message_stop / ping / error{ error: { type, message } }
 * 未知字段一律忽略（厂商自带 "p" 填充；CF 网关原样透传）。
 */
import type { CoreEventDraft, LoweringOutcome, LoweringStreamContext, TokenUsage } from "@reinsjs/core"
import type { ModelOrigin } from "../ir.js"
import type { SseMessage } from "../sse.js"
import { costOf, type ModelCost } from "../usage.js"

interface AnthropicUsage {
  input_tokens?: unknown
  output_tokens?: unknown
  cache_creation_input_tokens?: unknown
  cache_read_input_tokens?: unknown
}

interface AnthropicStreamEvent {
  type?: unknown
  message?: { id?: unknown; model?: unknown; usage?: AnthropicUsage | null }
  index?: unknown
  content_block?: {
    type?: unknown
    text?: unknown
    thinking?: unknown
    signature?: unknown
    data?: unknown
    id?: unknown
    name?: unknown
    input?: unknown
  }
  delta?: {
    type?: unknown
    text?: unknown
    thinking?: unknown
    signature?: unknown
    partial_json?: unknown
    stop_reason?: unknown
    stop_sequence?: unknown
    stop_details?: { category?: unknown; explanation?: unknown } | null
  }
  usage?: AnthropicUsage | null
  error?: { type?: unknown; message?: unknown }
}

type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted_thinking"; data: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown; json: string }
  | { kind: "other"; type: string }

export interface AnthropicStreamInput {
  messages: AsyncIterable<SseMessage>
  origin: ModelOrigin
  cost?: ModelCost
  signal?: AbortSignal
  timedOut?: () => boolean
  timeoutMs?: number
}

/** pi-ai 对 redacted_thinking 的正文约定，两条降级路线的事件互换 */
export const REDACTED_THINKING_TEXT = "[Reasoning redacted]"

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

/** 入参 JSON 解析不了就原样存字符串（写侧会包成 { value }），空串按 {} */
function parseInput(json: string, fallback: unknown): unknown {
  if (json.trim() === "") return typeof fallback === "object" && fallback !== null ? fallback : {}
  try {
    return JSON.parse(json) as unknown
  } catch {
    return json
  }
}

class AnthropicAssembly {
  readonly blocks = new Map<number, Block>()
  start: AnthropicUsage | undefined
  delta: AnthropicUsage | undefined
  responseModel: string | undefined
  stopReason: string | undefined
  stopDetails: { category?: unknown; explanation?: unknown } | undefined
  error: { type: string; message: string } | undefined
  sawStop = false

  drafts(origin: ModelOrigin): CoreEventDraft[] {
    const out: CoreEventDraft[] = []
    for (const [, b] of [...this.blocks.entries()].sort((x, y) => x[0] - y[0])) {
      const replay: Record<string, unknown> = { ...origin }
      switch (b.kind) {
        case "thinking":
          // 签名在、正文为空（display omitted）也要留草稿：下一轮必须原样回放
          if (b.thinking.length === 0 && b.signature.length === 0) break
          if (b.signature.length > 0) replay.thinkingSignature = b.signature
          out.push({ type: "core.model_thinking", actor: "model", payload: { text: b.thinking }, replay })
          break
        case "redacted_thinking":
          replay.thinkingSignature = b.data
          replay.redacted = true
          out.push({
            type: "core.model_thinking",
            actor: "model",
            payload: { text: REDACTED_THINKING_TEXT },
            replay,
          })
          break
        case "text":
          if (b.text.length > 0)
            out.push({ type: "core.model_text", actor: "model", payload: { text: b.text }, replay })
          break
        case "tool_use":
          out.push({
            type: "core.tool_call",
            actor: "model",
            payload: { toolCallId: b.id, name: b.name, args: parseInput(b.json, b.input) },
            replay,
          })
          break
        case "other":
          break
      }
    }
    return out
  }

  hasToolUse(): boolean {
    for (const b of this.blocks.values()) if (b.kind === "tool_use") return true
    return false
  }
}

/**
 * Anthropic 的 input_tokens 本就不含缓存部分（与 core 语义一致）；message_start 报输入侧，message_delta 报输出
 * （累计值）并可能再报一次输入侧，以后到的为准。
 */
export function usageOf(start: AnthropicUsage | undefined, delta: AnthropicUsage | undefined): TokenUsage {
  const pick = (k: keyof AnthropicUsage) => num(delta?.[k]) ?? num(start?.[k])
  const usage: TokenUsage = { input: pick("input_tokens") ?? 0, output: pick("output_tokens") ?? 0 }
  const read = pick("cache_read_input_tokens")
  const write = pick("cache_creation_input_tokens")
  if (read) usage.cacheRead = read
  if (write) usage.cacheWrite = write
  return usage
}

function apply(ev: AnthropicStreamEvent, a: AnthropicAssembly, ctx: LoweringStreamContext) {
  switch (ev.type) {
    case "message_start": {
      const model = str(ev.message?.model)
      if (model) a.responseModel = model
      if (ev.message?.usage) a.start = ev.message.usage
      break
    }
    case "content_block_start": {
      const index = num(ev.index)
      const cb = ev.content_block
      if (index === undefined || !cb) break
      const type = str(cb.type) ?? "unknown"
      switch (type) {
        case "text":
          a.blocks.set(index, { kind: "text", text: str(cb.text) ?? "" })
          break
        case "thinking":
          a.blocks.set(index, {
            kind: "thinking",
            thinking: str(cb.thinking) ?? "",
            signature: str(cb.signature) ?? "",
          })
          break
        case "redacted_thinking":
          a.blocks.set(index, { kind: "redacted_thinking", data: str(cb.data) ?? "" })
          break
        case "tool_use":
          a.blocks.set(index, {
            kind: "tool_use",
            id: str(cb.id) ?? "",
            name: str(cb.name) ?? "",
            input: cb.input,
            json: "",
          })
          break
        default:
          a.blocks.set(index, { kind: "other", type })
      }
      break
    }
    case "content_block_delta": {
      const index = num(ev.index)
      const d = ev.delta
      if (index === undefined || !d) break
      const b = a.blocks.get(index)
      if (!b) break
      switch (d.type) {
        case "text_delta": {
          const t = str(d.text)
          if (b.kind === "text" && t) {
            b.text += t
            ctx.onDelta?.({ kind: "text", index, delta: t })
          }
          break
        }
        case "thinking_delta": {
          const t = str(d.thinking)
          if (b.kind === "thinking" && t) {
            b.thinking += t
            ctx.onDelta?.({ kind: "thinking", index, delta: t })
          }
          break
        }
        case "signature_delta": {
          const s = str(d.signature)
          if (b.kind === "thinking" && s) b.signature += s
          break
        }
        case "input_json_delta": {
          const j = str(d.partial_json)
          if (b.kind === "tool_use" && j) {
            b.json += j
            ctx.onDelta?.({ kind: "tool_args", index, delta: j })
          }
          break
        }
        default:
          break
      }
      break
    }
    case "message_delta": {
      const reason = str(ev.delta?.stop_reason)
      if (reason) a.stopReason = reason
      if (ev.delta?.stop_details && typeof ev.delta.stop_details === "object")
        a.stopDetails = ev.delta.stop_details
      if (ev.usage) a.delta = { ...a.delta, ...ev.usage }
      break
    }
    case "message_stop":
      a.sawStop = true
      break
    case "error":
      a.error = { type: str(ev.error?.type) ?? "error", message: str(ev.error?.message) ?? "" }
      break
    default:
      // ping、content_block_stop 与未知事件：无事可做
      break
  }
}

/**
 * 停止原因：有 tool_use 块即 toolUse；end_turn / stop_sequence / pause_turn → stop；max_tokens 与
 * model_context_window_exceeded → length；refusal → error 并把 stop_details 写进 errorMessage（厂商分类器拒答，
 * 不是瞬断，core 不会重试）；流里的 error 事件 → error（overloaded_error 的文案含 Overloaded，core 判可重试）；
 * 没等到 message_stop 也没有 stop_reason → error "stream ended before message_stop"（可重试）。
 */
function outcomeOf(a: AnthropicAssembly, cost: ModelCost | undefined): LoweringOutcome {
  const usage = usageOf(a.start, a.delta)
  const out: LoweringOutcome = { stopReason: "stop", usage }
  const c = costOf(usage, cost)
  if (c !== undefined) out.costUsd = c
  if (a.responseModel) out.responseModel = a.responseModel

  if (a.error) {
    out.stopReason = "error"
    out.errorMessage = `${a.error.type}: ${a.error.message}`
    return out
  }
  if (a.hasToolUse()) {
    out.stopReason = "toolUse"
    return out
  }
  switch (a.stopReason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    case "tool_use":
      break
    case "max_tokens":
    case "model_context_window_exceeded":
      out.stopReason = "length"
      break
    case "refusal": {
      out.stopReason = "error"
      const category = str(a.stopDetails?.category)
      const explanation = str(a.stopDetails?.explanation)
      out.errorMessage = `stop_reason=refusal${category ? ` (${category})` : ""}：厂商分类器拒答${explanation ? `——${explanation}` : ""}`
      break
    }
    case undefined:
      if (!a.sawStop) {
        out.stopReason = "error"
        out.errorMessage = "stream ended before message_stop"
      }
      break
    default:
      break
  }
  return out
}

export async function* consumeAnthropicStream(
  input: AnthropicStreamInput,
  ctx: LoweringStreamContext = {},
): AsyncGenerator<CoreEventDraft, LoweringOutcome> {
  const a = new AnthropicAssembly()
  try {
    for await (const msg of input.messages) {
      let ev: AnthropicStreamEvent
      try {
        ev = JSON.parse(msg.data) as AnthropicStreamEvent
      } catch {
        // 解析不了的一帧：跳过而不是整条流作废，末尾若因此缺 message_stop 会记 error
        continue
      }
      apply(ev, a, ctx)
      if (a.error) break
    }
  } catch (err) {
    yield* a.drafts(input.origin)
    const base = outcomeOf(a, input.cost)
    if (input.signal?.aborted) return { ...base, stopReason: "aborted", errorMessage: "aborted by host" }
    if (input.timedOut?.())
      return {
        ...base,
        stopReason: "error",
        errorMessage: `request timed out after ${input.timeoutMs ?? "?"}ms (stream ended before message_stop)`,
      }
    return { ...base, stopReason: "error", errorMessage: errorText(err) }
  }
  yield* a.drafts(input.origin)
  return outcomeOf(a, input.cost)
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: unknown } }).cause
    const code = typeof cause?.code === "string" ? ` (${cause.code})` : ""
    return `${err.message}${code}`
  }
  return String(err)
}
