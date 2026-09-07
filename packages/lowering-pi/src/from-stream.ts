/**
 * pi-ai 流 → 事件草稿。
 *
 * 只在响应收尾（done / error）时按最终消息的内容块产出草稿：签名类回放数据（Anthropic signature、
 * OpenAI reasoning item）在块结束时才齐，等收尾最稳。增量只通过 onDelta 给 UI。
 * 中断或出错时把已产出的部分内容也交出去 —— 日志要记录"发生过什么"，是否继续由循环决定。
 */
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai"
import type { CoreEventDraft, LoweringOutcome, LoweringStreamContext } from "@reins/core"
import type { ModelOrigin } from "./to-request.js"

export function draftsOf(msg: AssistantMessage): CoreEventDraft[] {
  const origin: ModelOrigin = { provider: msg.provider, api: msg.api, model: msg.model }
  const drafts: CoreEventDraft[] = []
  for (const block of msg.content) {
    if (block.type === "thinking") {
      const replay: Record<string, unknown> = { ...origin }
      if (block.thinkingSignature) replay.thinkingSignature = block.thinkingSignature
      if (block.redacted) replay.redacted = true
      drafts.push({ type: "core.model_thinking", actor: "model", payload: { text: block.thinking }, replay })
    } else if (block.type === "text") {
      if (block.text.length === 0) continue
      const replay: Record<string, unknown> = { ...origin }
      if (block.textSignature) replay.textSignature = block.textSignature
      drafts.push({ type: "core.model_text", actor: "model", payload: { text: block.text }, replay })
    } else if (block.type === "toolCall") {
      const replay: Record<string, unknown> = { ...origin }
      if (block.thoughtSignature) replay.thoughtSignature = block.thoughtSignature
      if (block.namespace !== undefined) replay.namespace = block.namespace
      drafts.push({
        type: "core.tool_call",
        actor: "model",
        payload: { toolCallId: block.id, name: block.name, args: block.arguments },
        replay,
      })
    }
  }
  return drafts
}

function outcomeOf(msg: AssistantMessage, stopReason: LoweringOutcome["stopReason"]): LoweringOutcome {
  const usage: LoweringOutcome["usage"] = { input: msg.usage.input, output: msg.usage.output }
  if (msg.usage.cacheRead) usage.cacheRead = msg.usage.cacheRead
  if (msg.usage.cacheWrite) usage.cacheWrite = msg.usage.cacheWrite
  const out: LoweringOutcome = { stopReason, usage, costUsd: msg.usage.cost.total }
  if (msg.errorMessage) out.errorMessage = msg.errorMessage
  if (msg.responseModel) out.responseModel = msg.responseModel
  return out
}

export async function* consumeStream(
  events: AsyncIterable<AssistantMessageEvent>,
  ctx: LoweringStreamContext = {},
): AsyncGenerator<CoreEventDraft, LoweringOutcome> {
  for await (const ev of events) {
    switch (ev.type) {
      case "text_delta":
        ctx.onDelta?.({ kind: "text", index: ev.contentIndex, delta: ev.delta })
        break
      case "thinking_delta":
        ctx.onDelta?.({ kind: "thinking", index: ev.contentIndex, delta: ev.delta })
        break
      case "toolcall_delta":
        ctx.onDelta?.({ kind: "tool_args", index: ev.contentIndex, delta: ev.delta })
        break
      case "done": {
        yield* draftsOf(ev.message)
        // pi-ai 的 "deferred" 是异步批处理句柄，第一版不支持，按 stop 收尾并保留 rawStopReason 给排查
        const reason = ev.reason === "deferred" ? "stop" : ev.reason
        return outcomeOf(ev.message, reason)
      }
      case "error":
        yield* draftsOf(ev.error)
        return outcomeOf(ev.error, ev.reason)
      default:
        break
    }
  }
  return {
    stopReason: "error",
    usage: { input: 0, output: 0 },
    errorMessage: "pi-ai 流在 done / error 之前就结束了",
  }
}
