/**
 * OpenAI Responses 流 → 事件草稿。
 *
 * 只在流收尾时按拼好的输出项产出草稿（reasoning 项的 encrypted_content 在 output_item.done 才齐），增量经 onDelta 给 UI。
 * 中断或出错时把已拼出的部分内容也交出去——日志要记录"发生过什么"，是否继续由循环决定。
 *
 * 事件形状（厂商 SSE，按 data.type 分派；F0 R2 实测事件序列完整）：
 *   response.created / response.in_progress { response: { id, model } }
 *   response.output_item.added { output_index, item: reasoning | message | function_call | … }
 *   response.reasoning_summary_part.added / response.reasoning_summary_text.delta { output_index, delta } / response.reasoning_text.delta
 *   response.output_text.delta / response.refusal.delta { output_index, delta }
 *   response.function_call_arguments.delta { output_index, delta } / response.function_call_arguments.done { arguments }
 *   response.output_item.done { output_index, item }           ← 项的最终形状（reasoning 带 encrypted_content、message 带 id）
 *   response.completed / response.incomplete { response: { status, incomplete_details, usage, output } }
 *   response.failed { response: { error: { code, message } } } / error { code, message }
 * 未知字段一律忽略（CF 网关会多个 "p"）。
 */
import type { CoreEventDraft, LoweringOutcome, LoweringStreamContext, TokenUsage } from "@reinsjs/core"
import type { ModelOrigin } from "../ir.js"
import type { SseMessage } from "../sse.js"
import { costOf, type ModelCost } from "../usage.js"

interface ResponsesUsage {
  input_tokens?: unknown
  output_tokens?: unknown
  input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown } | null
  output_tokens_details?: { reasoning_tokens?: unknown } | null
}

interface ResponsesItem {
  type?: unknown
  id?: unknown
  call_id?: unknown
  name?: unknown
  arguments?: unknown
  phase?: unknown
  encrypted_content?: unknown
  summary?: { type?: unknown; text?: unknown }[]
  content?: { type?: unknown; text?: unknown; refusal?: unknown }[]
  [k: string]: unknown
}

interface ResponsesStreamEvent {
  type?: unknown
  output_index?: unknown
  item?: ResponsesItem
  delta?: unknown
  arguments?: unknown
  code?: unknown
  message?: unknown
  response?: {
    id?: unknown
    model?: unknown
    status?: unknown
    incomplete_details?: { reason?: unknown } | null
    usage?: ResponsesUsage | null
    output?: ResponsesItem[]
    error?: { code?: unknown; message?: unknown } | null
  }
}

type Slot =
  | { kind: "reasoning"; id: string; summary: string; item: ResponsesItem | undefined }
  | { kind: "message"; id: string; text: string; phase: string | undefined }
  | { kind: "function_call"; id: string; callId: string; name: string; args: string }
  | { kind: "other"; type: string }

export interface ResponsesStreamInput {
  messages: AsyncIterable<SseMessage>
  origin: ModelOrigin
  cost?: ModelCost
  signal?: AbortSignal
  timedOut?: () => boolean
  timeoutMs?: number
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

/** 入参 JSON 解析不了就原样存字符串（写侧原样送回），空串按 {} */
function parseArguments(raw: string): unknown {
  if (raw.trim() === "") return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/** reasoning 项的可见正文：summary 各段以空行拼接；没有 summary 的上游可能给 content（原文推理） */
function reasoningText(item: ResponsesItem | undefined, fallback: string): string {
  if (!item) return fallback
  const summary = (item.summary ?? []).map((s) => str(s.text) ?? "").filter((t) => t.length > 0)
  if (summary.length > 0) return summary.join("\n\n")
  const content = (item.content ?? []).map((c) => str(c.text) ?? "").filter((t) => t.length > 0)
  return content.length > 0 ? content.join("\n\n") : fallback
}

function messageText(item: ResponsesItem | undefined, fallback: string): string {
  if (!item?.content) return fallback
  return item.content.map((c) => (c.type === "refusal" ? str(c.refusal) : str(c.text)) ?? "").join("")
}

class ResponsesAssembly {
  readonly slots = new Map<number, Slot>()
  responseId: string | undefined
  responseModel: string | undefined
  status: string | undefined
  incompleteReason: string | undefined
  usage: ResponsesUsage | undefined
  error: { code: string; message: string } | undefined
  sawTerminal = false

  slotFor(index: number, item: ResponsesItem): Slot {
    let slot = this.slots.get(index)
    if (slot) return slot
    const type = str(item.type) ?? "unknown"
    switch (type) {
      case "reasoning":
        slot = { kind: "reasoning", id: str(item.id) ?? "", summary: "", item: undefined }
        break
      case "message":
        slot = { kind: "message", id: str(item.id) ?? "", text: "", phase: str(item.phase) }
        break
      case "function_call":
        slot = {
          kind: "function_call",
          id: str(item.id) ?? "",
          callId: str(item.call_id) ?? "",
          name: str(item.name) ?? "",
          args: str(item.arguments) ?? "",
        }
        break
      default:
        slot = { kind: "other", type }
    }
    this.slots.set(index, slot)
    return slot
  }

  /** 项收尾：以厂商给的最终形状为准（reasoning 带 encrypted_content、message 带 id / phase、function_call 带完整 arguments） */
  finish(index: number, item: ResponsesItem) {
    const slot = this.slotFor(index, item)
    switch (slot.kind) {
      case "reasoning":
        slot.item = item
        slot.id = str(item.id) ?? slot.id
        slot.summary = reasoningText(item, slot.summary)
        break
      case "message":
        slot.id = str(item.id) ?? slot.id
        slot.phase = str(item.phase) ?? slot.phase
        slot.text = messageText(item, slot.text)
        break
      case "function_call":
        slot.id = str(item.id) ?? slot.id
        slot.callId = str(item.call_id) ?? slot.callId
        slot.name = str(item.name) ?? slot.name
        slot.args = str(item.arguments) ?? slot.args
        break
      case "other":
        break
    }
  }

  /**
   * Azure 等上游可能只在 response.completed 的 output 里给 encrypted_content（output_item.done 里没有），
   * 按 id 回填，让 store:false 的多轮回放不断（pi-ai 同一处置）。
   */
  backfill(output: ResponsesItem[] | undefined) {
    if (!output) return
    for (const item of output) {
      if (item.type !== "reasoning" || typeof item.encrypted_content !== "string") continue
      for (const slot of this.slots.values()) {
        if (slot.kind !== "reasoning" || slot.id !== item.id) continue
        if (!slot.item) slot.item = item
        else if (typeof slot.item.encrypted_content !== "string")
          slot.item = { ...slot.item, encrypted_content: item.encrypted_content }
      }
    }
  }

  hasFunctionCall(): boolean {
    for (const s of this.slots.values()) if (s.kind === "function_call") return true
    return false
  }

  drafts(origin: ModelOrigin): CoreEventDraft[] {
    const out: CoreEventDraft[] = []
    for (const [, s] of [...this.slots.entries()].sort((x, y) => x[0] - y[0])) {
      const replay: Record<string, unknown> = { ...origin }
      switch (s.kind) {
        case "reasoning": {
          const encrypted =
            typeof s.item?.encrypted_content === "string" && s.item.encrypted_content.length > 0
          // 没有加密项又没有可见摘要的 reasoning 项什么都承载不了；有加密项、摘要为空的也要留草稿（下一轮必须原样回放）
          if (!encrypted && s.summary.length === 0) break
          if (encrypted) replay.thinkingSignature = JSON.stringify(s.item)
          out.push({ type: "core.model_thinking", actor: "model", payload: { text: s.summary }, replay })
          break
        }
        case "message":
          if (s.text.length === 0) break
          if (s.id) replay.textSignature = s.id
          if (s.phase) replay.phase = s.phase
          out.push({ type: "core.model_text", actor: "model", payload: { text: s.text }, replay })
          break
        case "function_call":
          if (s.id) replay.itemId = s.id
          out.push({
            type: "core.tool_call",
            actor: "model",
            payload: { toolCallId: s.callId, name: s.name, args: parseArguments(s.args) },
            replay,
          })
          break
        case "other":
          break
      }
    }
    return out
  }
}

/**
 * OpenAI 的 input_tokens 含缓存命中与缓存写入部分（F0 R1 / R4 实测 `input_tokens_details.cached_tokens` / `cache_write_tokens`），
 * core 的 input 是未命中数，所以两者都要减掉。
 */
export function usageOf(u: ResponsesUsage | undefined): TokenUsage {
  const total = num(u?.input_tokens) ?? 0
  const cached = num(u?.input_tokens_details?.cached_tokens) ?? 0
  const written = num(u?.input_tokens_details?.cache_write_tokens) ?? 0
  const usage: TokenUsage = {
    input: Math.max(0, total - cached - written),
    output: num(u?.output_tokens) ?? 0,
  }
  if (cached > 0) usage.cacheRead = cached
  if (written > 0) usage.cacheWrite = written
  return usage
}

function apply(ev: ResponsesStreamEvent, a: ResponsesAssembly, ctx: LoweringStreamContext) {
  const type = str(ev.type)
  const index = num(ev.output_index)
  const slot = index === undefined ? undefined : a.slots.get(index)
  switch (type) {
    case "response.created":
    case "response.in_progress": {
      const id = str(ev.response?.id)
      const model = str(ev.response?.model)
      if (id) a.responseId = id
      if (model) a.responseModel = model
      break
    }
    case "response.output_item.added":
      if (index !== undefined && ev.item) a.slotFor(index, ev.item)
      break
    case "response.reasoning_summary_part.added":
      // 第二段起用空行隔开，与收尾时 summary 各段以 "\n\n" 拼接一致
      if (slot?.kind === "reasoning" && slot.summary.length > 0 && index !== undefined) {
        slot.summary += "\n\n"
        ctx.onDelta?.({ kind: "thinking", index, delta: "\n\n" })
      }
      break
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      const d = str(ev.delta)
      if (slot?.kind === "reasoning" && d && index !== undefined) {
        slot.summary += d
        ctx.onDelta?.({ kind: "thinking", index, delta: d })
      }
      break
    }
    case "response.output_text.delta":
    case "response.refusal.delta": {
      const d = str(ev.delta)
      if (slot?.kind === "message" && d && index !== undefined) {
        slot.text += d
        ctx.onDelta?.({ kind: "text", index, delta: d })
      }
      break
    }
    case "response.function_call_arguments.delta": {
      const d = str(ev.delta)
      if (slot?.kind === "function_call" && d && index !== undefined) {
        slot.args += d
        ctx.onDelta?.({ kind: "tool_args", index, delta: d })
      }
      break
    }
    case "response.function_call_arguments.done": {
      const full = str(ev.arguments)
      if (slot?.kind === "function_call" && full !== undefined) slot.args = full
      break
    }
    case "response.output_item.done":
      if (index !== undefined && ev.item) a.finish(index, ev.item)
      break
    case "response.completed":
    case "response.incomplete": {
      a.sawTerminal = true
      const r = ev.response
      a.status = str(r?.status) ?? (type === "response.completed" ? "completed" : "incomplete")
      a.incompleteReason = str(r?.incomplete_details?.reason)
      if (r?.usage) a.usage = r.usage
      const model = str(r?.model)
      if (model) a.responseModel = model
      a.backfill(r?.output)
      break
    }
    case "response.failed": {
      a.sawTerminal = true
      a.status = "failed"
      const e = ev.response?.error
      a.error = { code: str(e?.code) ?? "failed", message: str(e?.message) ?? "response.failed 没有错误详情" }
      if (ev.response?.usage) a.usage = ev.response.usage
      break
    }
    case "error":
      a.error = { code: str(ev.code) ?? "error", message: str(ev.message) ?? "" }
      break
    default:
      // response.output_text.done / content_part.* / reasoning_summary_part.done / 未知事件：无事可做
      break
  }
}

/**
 * 停止原因：流里的 error / response.failed → error（文案 "<code>: <message>"，rate_limit_exceeded 之类 core 判可重试）；
 * 有 function_call 项即 toolUse；completed → stop；incomplete + max_output_tokens → length、incomplete + content_filter → error
 * （厂商内容过滤，不重试）；cancelled → error；没等到终态事件 → error "stream ended before response.completed"（可重试）。
 */
function outcomeOf(a: ResponsesAssembly, cost: ModelCost | undefined): LoweringOutcome {
  const usage = usageOf(a.usage)
  const out: LoweringOutcome = { stopReason: "stop", usage }
  const c = costOf(usage, cost)
  if (c !== undefined) out.costUsd = c
  if (a.responseModel) out.responseModel = a.responseModel

  if (a.error) {
    out.stopReason = "error"
    out.errorMessage = `${a.error.code}: ${a.error.message}`
    return out
  }
  if (!a.sawTerminal) {
    out.stopReason = "error"
    out.errorMessage = "stream ended before response.completed"
    return out
  }
  if (a.hasFunctionCall()) {
    out.stopReason = "toolUse"
    return out
  }
  switch (a.status) {
    case "completed":
      break
    case "incomplete":
      if (a.incompleteReason === "max_output_tokens") out.stopReason = "length"
      else {
        out.stopReason = "error"
        out.errorMessage =
          a.incompleteReason === "content_filter"
            ? "status=incomplete (content_filter)：厂商内容过滤截停了这次输出"
            : `status=incomplete${a.incompleteReason ? ` (${a.incompleteReason})` : ""}：厂商没有说完`
      }
      break
    case "cancelled":
    case "failed":
      out.stopReason = "error"
      out.errorMessage = `status=${a.status}`
      break
    default:
      break
  }
  return out
}

export async function* consumeResponsesStream(
  input: ResponsesStreamInput,
  ctx: LoweringStreamContext = {},
): AsyncGenerator<CoreEventDraft, LoweringOutcome> {
  const a = new ResponsesAssembly()
  try {
    for await (const msg of input.messages) {
      if (msg.data === "[DONE]") break
      let ev: ResponsesStreamEvent
      try {
        ev = JSON.parse(msg.data) as ResponsesStreamEvent
      } catch {
        // 解析不了的一帧：跳过而不是整条流作废，末尾若因此缺终态事件会记 error
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
        errorMessage: `request timed out after ${input.timeoutMs ?? "?"}ms (stream ended before response.completed)`,
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
