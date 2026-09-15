/**
 * Chat Completions 流 → 事件草稿。
 *
 * 只在流收尾时按拼好的块产出草稿（与 lowering-pi 同策略：日志里只存完整块），增量经 onDelta 给 UI。
 * 中断或出错时把已拼出的部分内容也交出去——日志要记录"发生过什么"，是否继续由循环决定。
 *
 * chunk 形状（OpenAI 规范 + DeepSeek 已验证的 `delta.reasoning_content`）：
 *   choices[0].delta.{ content, reasoning_content, tool_calls[{ index, id?, function: { name?, arguments? } }] }
 *   choices[0].finish_reason 在末块；usage 在带 stream_options.include_usage 的最后一个 chunk（choices 可能为空数组）
 *   `data: [DONE]` 收尾。未知字段一律忽略（CF 网关会多个 "p"，OpenAI 常带 system_fingerprint / obfuscation）。
 */
import type { CoreEventDraft, LoweringOutcome, LoweringStreamContext, TokenUsage } from "@reinsjs/core"
import type { ModelOrigin } from "../ir.js"
import type { SseMessage } from "../sse.js"
import { costOf, type ModelCost } from "../usage.js"

interface ChatChunk {
  model?: unknown
  choices?: {
    delta?: {
      content?: unknown
      reasoning_content?: unknown
      tool_calls?: { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }[]
    }
    finish_reason?: unknown
  }[]
  usage?: ChatUsage | null
}

interface ChatUsage {
  prompt_tokens?: unknown
  completion_tokens?: unknown
  prompt_tokens_details?: { cached_tokens?: unknown } | null
  /** DeepSeek 原生字段，与 prompt_tokens_details.cached_tokens 同值 */
  prompt_cache_hit_tokens?: unknown
}

export interface ChatStreamInput {
  messages: AsyncIterable<SseMessage>
  origin: ModelOrigin
  cost?: ModelCost
  /** 宿主中止信号：读流被中止时据此判"aborted"还是本地超时 */
  signal?: AbortSignal
  timedOut?: () => boolean
  timeoutMs?: number
}

/** 拼装中的一轮输出 */
class ChatAssembly {
  reasoning = ""
  text = ""
  readonly calls = new Map<number, { id: string; name: string; args: string }>()
  finish: string | undefined
  usage: ChatUsage | undefined
  responseModel: string | undefined
  /** onDelta 用的块序号：按首次出现顺序分配 */
  private readonly blockIndex = new Map<string, number>()

  indexOf(key: string): number {
    let i = this.blockIndex.get(key)
    if (i === undefined) {
      i = this.blockIndex.size
      this.blockIndex.set(key, i)
    }
    return i
  }

  drafts(origin: ModelOrigin): CoreEventDraft[] {
    const out: CoreEventDraft[] = []
    const replay: Record<string, unknown> = { ...origin }
    if (this.reasoning.length > 0)
      out.push({ type: "core.model_thinking", actor: "model", payload: { text: this.reasoning }, replay })
    if (this.text.length > 0)
      out.push({ type: "core.model_text", actor: "model", payload: { text: this.text }, replay })
    for (const [, c] of [...this.calls.entries()].sort((a, b) => a[0] - b[0])) {
      out.push({
        type: "core.tool_call",
        actor: "model",
        payload: { toolCallId: c.id, name: c.name, args: parseArguments(c.args) },
        replay,
      })
    }
    return out
  }
}

/** 入参 JSON 解析不了就原样存字符串：工具校验会把错误告诉模型，写侧再原样送回（to-request.ts argumentsOf） */
function parseArguments(raw: string): unknown {
  if (raw.trim() === "") return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

/** OpenAI 的 prompt_tokens 含缓存命中部分；core 的 input 是未命中数，所以要减掉 */
export function usageOf(u: ChatUsage | undefined): TokenUsage {
  const prompt = num(u?.prompt_tokens) ?? 0
  const cached = num(u?.prompt_tokens_details?.cached_tokens) ?? num(u?.prompt_cache_hit_tokens) ?? 0
  const usage: TokenUsage = { input: Math.max(0, prompt - cached), output: num(u?.completion_tokens) ?? 0 }
  if (cached > 0) usage.cacheRead = cached
  return usage
}

function apply(chunk: ChatChunk, a: ChatAssembly, ctx: LoweringStreamContext) {
  if (typeof chunk.model === "string" && chunk.model !== "") a.responseModel = chunk.model
  if (chunk.usage && typeof chunk.usage === "object") a.usage = chunk.usage
  const choice = chunk.choices?.[0]
  if (!choice) return
  const d = choice.delta
  if (d) {
    if (typeof d.reasoning_content === "string" && d.reasoning_content !== "") {
      a.reasoning += d.reasoning_content
      ctx.onDelta?.({ kind: "thinking", index: a.indexOf("thinking"), delta: d.reasoning_content })
    }
    if (typeof d.content === "string" && d.content !== "") {
      a.text += d.content
      ctx.onDelta?.({ kind: "text", index: a.indexOf("text"), delta: d.content })
    }
    for (const tc of d.tool_calls ?? []) {
      const index = num(tc.index) ?? 0
      let call = a.calls.get(index)
      if (!call) {
        call = { id: "", name: "", args: "" }
        a.calls.set(index, call)
      }
      if (typeof tc.id === "string" && tc.id !== "") call.id = tc.id
      if (typeof tc.function?.name === "string" && tc.function.name !== "") call.name = tc.function.name
      if (typeof tc.function?.arguments === "string" && tc.function.arguments !== "") {
        call.args += tc.function.arguments
        ctx.onDelta?.({ kind: "tool_args", index: a.indexOf(`tool:${index}`), delta: tc.function.arguments })
      }
    }
  }
  if (typeof choice.finish_reason === "string") a.finish = choice.finish_reason
}

/**
 * 停止原因：有 tool_call 就是 toolUse（强制 tool_choice 时官方 finish_reason 是 stop，F0 实测）；
 * content_filter / insufficient_system_resource（DeepSeek 服务端资源不足）/ aborted（服务端中止）都是"没正常说完"，
 * 记 error 并把原因写进 errorMessage——core 只按文案判是否重试，资源不足那条写明 temporarily unavailable 让它值得再试。
 */
function outcomeOf(a: ChatAssembly, cost: ModelCost | undefined, sawDone: boolean): LoweringOutcome {
  const usage = usageOf(a.usage)
  const out: LoweringOutcome = { stopReason: "stop", usage }
  const c = costOf(usage, cost)
  if (c !== undefined) out.costUsd = c
  if (a.responseModel) out.responseModel = a.responseModel

  if (a.calls.size > 0) out.stopReason = "toolUse"
  else {
    switch (a.finish) {
      case "stop":
      case "tool_calls":
        break
      case "length":
        out.stopReason = "length"
        break
      case "content_filter":
        out.stopReason = "error"
        out.errorMessage = "finish_reason=content_filter: the provider's content filter cut this output short"
        break
      case "insufficient_system_resource":
        out.stopReason = "error"
        out.errorMessage = "finish_reason=insufficient_system_resource (service temporarily unavailable)"
        break
      case "aborted":
        out.stopReason = "error"
        out.errorMessage = "finish_reason=aborted: the server aborted this generation"
        break
      case undefined:
        if (!sawDone || a.text.length === 0) {
          out.stopReason = "error"
          out.errorMessage = "stream ended before finish_reason"
        }
        break
      default:
        break
    }
  }
  return out
}

export async function* consumeChatStream(
  input: ChatStreamInput,
  ctx: LoweringStreamContext = {},
): AsyncGenerator<CoreEventDraft, LoweringOutcome> {
  const a = new ChatAssembly()
  let sawDone = false
  try {
    for await (const msg of input.messages) {
      if (msg.data === "[DONE]") {
        sawDone = true
        break
      }
      let chunk: ChatChunk
      try {
        chunk = JSON.parse(msg.data) as ChatChunk
      } catch {
        // 解析不了的一帧：跳过而不是整条流作废，末尾若因此缺 finish_reason 会记 error
        continue
      }
      apply(chunk, a, ctx)
    }
  } catch (err) {
    yield* a.drafts(input.origin)
    const base = outcomeOf(a, input.cost, false)
    if (input.signal?.aborted) return { ...base, stopReason: "aborted", errorMessage: "aborted by host" }
    if (input.timedOut?.())
      return {
        ...base,
        stopReason: "error",
        errorMessage: `request timed out after ${input.timeoutMs ?? "?"}ms (stream ended before finish_reason)`,
      }
    return { ...base, stopReason: "error", errorMessage: errorText(err) }
  }
  yield* a.drafts(input.origin)
  return outcomeOf(a, input.cost, sawDone)
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause
    const code = typeof cause?.code === "string" ? ` (${cause.code})` : ""
    return `${err.message}${code}`
  }
  return String(err)
}
