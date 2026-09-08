/**
 * 事件 → pi-ai Context（三角色 Message[] + tools + systemPrompt），并逐条记录落点。
 *
 * 分组规则：连续的 model 事件（thinking / text / tool_call）合成一条 AssistantMessage，
 * 遇到任何非 model 事件就收口。AssistantMessage 需要 api/provider/model 才能让 pi-ai 判断
 * "这段 thinking 是不是本模型产的、能不能回放"，这些信息在事件产出时记在 replay 里。
 */
import type {
  AssistantMessage,
  Context,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
} from "@earendil-works/pi-ai"
import type {
  ContentPart,
  CoreEvent,
  Event,
  LandingRecord,
  LoweringCapabilities,
  ToolSpec,
} from "@reins/core"
import type { PiModel } from "./models.js"
import { framedSystemNote, markSystemNote } from "./system-note.js"

/** 模型事件 replay 里记录的来源，产出与回放两头共用 */
export interface ModelOrigin {
  provider: string
  api: string
  model: string
}

export interface ThinkingReplay extends Partial<ModelOrigin> {
  thinkingSignature?: string
  redacted?: boolean
}
export interface TextReplay extends Partial<ModelOrigin> {
  textSignature?: string
}
export interface ToolCallReplay extends Partial<ModelOrigin> {
  thoughtSignature?: string
  namespace?: string
}

const ZERO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function toPiContent(
  parts: readonly ContentPart[],
): (TextContent | { type: "image"; data: string; mimeType: string })[] {
  return parts.map((p) =>
    p.type === "text" ? { type: "text", text: p.text } : { type: "image", data: p.data, mimeType: p.mime },
  )
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function originOf(replay: Record<string, unknown> | undefined, fallback: PiModel): ModelOrigin {
  const r = (replay ?? {}) as Partial<ModelOrigin>
  return {
    provider: typeof r.provider === "string" ? r.provider : fallback.provider,
    api: typeof r.api === "string" ? r.api : fallback.api,
    model: typeof r.model === "string" ? r.model : fallback.id,
  }
}

function sameOrigin(a: ModelOrigin, b: ModelOrigin): boolean {
  return a.provider === b.provider && a.api === b.api && a.model === b.model
}

/**
 * 是否来自别家：只比 provider 与 api。响应里报告的模型 id 常与请求的不同（带日期后缀、别名、网关改名），
 * 同家同协议下签名仍可回放，不算有损，只在落点备注里留痕。
 */
function foreignOrigin(a: ModelOrigin, target: ModelOrigin): boolean {
  return a.provider !== target.provider || a.api !== target.api
}

export interface ToContextInput {
  events: readonly Event[]
  tools?: readonly ToolSpec[]
  model: PiModel
  capabilities: LoweringCapabilities
  systemPrompt?: string
}

export function eventsToContext(input: ToContextInput): { context: Context; landings: LandingRecord[] } {
  const { model, capabilities } = input
  const target: ModelOrigin = { provider: model.provider, api: model.api, model: model.id }
  const isAnthropic = model.api === "anthropic-messages"
  const messages: Message[] = []
  const landings: LandingRecord[] = []

  let group: { origin: ModelOrigin; content: AssistantMessage["content"]; at: number } | null = null
  const flush = () => {
    if (!group) return
    const hasTool = group.content.some((c) => c.type === "toolCall")
    messages.push({
      role: "assistant",
      content: group.content,
      api: group.origin.api,
      provider: group.origin.provider,
      model: group.origin.model,
      usage: ZERO_USAGE,
      stopReason: hasTool ? "toolUse" : "stop",
      timestamp: group.at,
    })
    group = null
  }
  const assistant = (e: Event, origin: ModelOrigin) => {
    if (group && !sameOrigin(group.origin, origin)) flush()
    if (!group) group = { origin, content: [], at: e.at }
    return group
  }
  const land = (e: Event, kind: LandingRecord["kind"], landing: string, note?: string) => {
    landings.push(
      note
        ? { eventId: e.id, type: e.type, kind, landing, note }
        : { eventId: e.id, type: e.type, kind, landing },
    )
  }

  for (const raw of input.events) {
    const e = raw as CoreEvent
    switch (e.type) {
      case "core.user_message":
        flush()
        messages.push({ role: "user", content: toPiContent(e.payload.content), timestamp: e.at })
        land(e, "exact", "user")
        break

      case "core.model_thinking": {
        const origin = originOf(e.replay, model)
        const r = (e.replay ?? {}) as ThinkingReplay
        const block: ThinkingContent = { type: "thinking", thinking: e.payload.text }
        if (typeof r.thinkingSignature === "string") block.thinkingSignature = r.thinkingSignature
        if (r.redacted === true) block.redacted = true
        assistant(e, origin).content.push(block)
        if (!block.thinkingSignature)
          land(e, "lossy", "text-or-drop", "无签名的 thinking 由 pi-ai 降为文本或丢弃")
        else if (foreignOrigin(origin, target))
          land(
            e,
            "lossy",
            "provider-dependent",
            `来自 ${origin.provider}/${origin.model} 的 thinking，厂商可能忽略或拒收`,
          )
        else if (origin.model !== target.model)
          land(
            e,
            "exact",
            isAnthropic ? "thinking-block" : "reasoning-item",
            `签名来自 ${origin.model}，当前请求 ${target.model}`,
          )
        else land(e, "exact", isAnthropic ? "thinking-block" : "reasoning-item")
        break
      }

      case "core.model_text": {
        const origin = originOf(e.replay, model)
        const r = (e.replay ?? {}) as TextReplay
        const block: TextContent = { type: "text", text: e.payload.text }
        if (typeof r.textSignature === "string") block.textSignature = r.textSignature
        assistant(e, origin).content.push(block)
        land(e, "exact", isAnthropic ? "assistant-text" : "assistant-message")
        break
      }

      case "core.tool_call": {
        const origin = originOf(e.replay, model)
        const r = (e.replay ?? {}) as ToolCallReplay
        const wrapped = !isPlainObject(e.payload.args)
        const block: ToolCall = {
          type: "toolCall",
          id: e.payload.toolCallId,
          name: e.payload.name,
          arguments: wrapped ? { value: e.payload.args } : (e.payload.args as Record<string, unknown>),
        }
        if (typeof r.thoughtSignature === "string") block.thoughtSignature = r.thoughtSignature
        if (typeof r.namespace === "string") block.namespace = r.namespace
        assistant(e, origin).content.push(block)
        if (wrapped) land(e, "lossy", "wrapped-args", "非对象入参包成 { value }")
        else land(e, "exact", isAnthropic ? "tool_use" : "function_call")
        break
      }

      case "core.tool_result":
        flush()
        messages.push({
          role: "toolResult",
          toolCallId: e.payload.toolCallId,
          toolName: e.payload.name,
          content: toPiContent(e.payload.content),
          isError: e.payload.isError,
          timestamp: e.at,
        })
        land(e, "exact", isAnthropic ? "tool_result" : "function_call_output")
        break

      case "core.system_note":
        flush()
        if (capabilities.midConversationSystem) {
          messages.push({ role: "user", content: markSystemNote(e.payload.text), timestamp: e.at })
          land(e, "exact", isAnthropic ? "system" : model.reasoning ? "developer" : "system")
        } else {
          messages.push({
            role: "user",
            content: framedSystemNote(e.payload.kind, e.payload.text),
            timestamp: e.at,
          })
          land(e, "lossy", "user-role", "模型不支持中途 system，以 <system_note> 标签包住走 user 角色")
        }
        break

      case "core.compaction":
        flush()
        messages.push({
          role: "user",
          content: `[Summary of earlier conversation]\n${e.payload.summary}`,
          timestamp: e.at,
        })
        land(e, "lossy", "user-text", "摘要以 user 角色文本呈现")
        break

      case "core.approval_request":
      case "core.approval_decision":
      case "core.run_paused":
      case "core.run_resumed":
      case "core.budget_usage":
      case "core.memory_op":
      case "core.handoff":
      case "core.error":
        land(e, "dropped", "none", "运维事件不下发（投影默认已过滤）")
        break

      default:
        land(raw, "dropped", "none", `无通用落点：${raw.type}`)
    }
  }
  flush()

  const context: Context = { messages }
  if (input.systemPrompt) context.systemPrompt = input.systemPrompt
  if (input.tools && input.tools.length > 0) {
    // pi-ai 的 parameters 是 typebox TSchema，运行时就是 JSON Schema 对象，直接透传
    context.tools = input.tools.map(
      (t): Tool => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Tool["parameters"],
      }),
    )
  }
  return { context, landings }
}
