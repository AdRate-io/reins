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
import {
  type ContentPart,
  type CoreEvent,
  type Event,
  type LandingRecord,
  type LoweringCapabilities,
  markUntrusted,
  markUntrustedText,
  needsUntrustedMark,
  renderToolReference,
  type ToolSpec,
  untrustedSourceOf,
} from "@reinsjs/core"
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
  return parts.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text }
    // 工具引用段（L1）：pi-ai 的请求整形改不了，没有 defer_loading 落点，展开成文本
    if (p.type === "tool_reference") return { type: "text", text: renderToolReference(p) }
    return { type: "image", data: p.data, mimeType: p.mime }
  })
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

const DEFERRED_NOTE =
  "moved after that batch of tool results (tool results must immediately follow their call)"
const ESCAPED_NOTE = "an early-closing </untrusted inside untrusted content was escaped"

export interface ToContextInput {
  events: readonly Event[]
  tools?: readonly ToolSpec[]
  model: PiModel
  capabilities: LoweringCapabilities
  systemPrompt?: string
  /** trust=untrusted 的内容（工具输出、外部内容）以 <untrusted source=…> 包裹（§14）。缺省 true；关掉是宿主自担风险 */
  trustMarkers?: boolean
}

export function eventsToContext(input: ToContextInput): { context: Context; landings: LandingRecord[] } {
  const { model, capabilities } = input
  const target: ModelOrigin = { provider: model.provider, api: model.api, model: model.id }
  const isAnthropic = model.api === "anthropic-messages"
  const trustMarkers = input.trustMarkers !== false
  const messages: Message[] = []
  const landings: LandingRecord[] = []

  let group: { origin: ModelOrigin; content: AssistantMessage["content"]; at: number } | null = null
  /**
   * 已下发 tool_call、结果还没到的调用 id。Anthropic 要求同一批 tool_result 紧跟在 tool_use 所在的 assistant 之后、
   * 连成一条 user，中间不能插别的消息；而日志里 pin / memory 留痕的说明、感知说明都可能落在两条 tool_result 之间
   * （并行工具时 ctx.emit 的草稿排在各自结果之前），用户也可能在结果回来之前插话（续跑带新 input、进程死亡后再发消息）。
   * 所以结果没到齐时，说明、摘要与用户消息先攒着，到齐后再放出（落点备注说明后移）。时间线本身如实保留插话的位置。
   */
  const awaiting = new Set<string>()
  const deferred: {
    msg: Message
    event: Event
    kind: LandingRecord["kind"]
    landing: string
    note?: string
  }[] = []
  const land = (e: Event, kind: LandingRecord["kind"], landing: string, note?: string) => {
    landings.push(
      note
        ? { eventId: e.id, type: e.type, kind, landing, note }
        : { eventId: e.id, type: e.type, kind, landing },
    )
  }
  const releaseDeferred = () => {
    for (const d of deferred) {
      messages.push(d.msg)
      land(d.event, d.kind, d.landing, d.note ? `${d.note}；${DEFERRED_NOTE}` : DEFERRED_NOTE)
    }
    deferred.length = 0
  }
  /**
   * trust 标注（§14）：untrusted 的内容包上 <untrusted source=…>，事件本身不动。
   * 返回翻译后的片段与"是否因转义而有损"——内容里出现提前闭合的标签时被转义，落点要记 lossy。
   */
  const content = (e: Event, parts: readonly ContentPart[]): { parts: ContentPart[]; escaped: boolean } => {
    if (!trustMarkers || !needsUntrustedMark(e)) return { parts: [...parts], escaped: false }
    return markUntrusted(parts, untrustedSourceOf(e))
  }
  const text = (e: Event, s: string): { text: string; escaped: boolean } => {
    if (!trustMarkers || !needsUntrustedMark(e)) return { text: s, escaped: false }
    return markUntrustedText(s, untrustedSourceOf(e))
  }
  /** 说明 / 摘要类消息：工具结果还没到齐就先攒着 */
  const note = (e: Event, msg: Message, kind: LandingRecord["kind"], landing: string, why?: string) => {
    if (awaiting.size > 0) {
      deferred.push({ msg, event: e, kind, landing, ...(why !== undefined ? { note: why } : {}) })
      return
    }
    messages.push(msg)
    land(e, kind, landing, why)
  }
  /** 新的模型输出到来：这批调用的结果不会再来了（视图被切在了结果之前），后移的一切放出 */
  const settleAwaiting = () => {
    awaiting.clear()
    releaseDeferred()
  }
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
    for (const c of group.content) if (c.type === "toolCall") awaiting.add(c.id)
    group = null
  }
  const assistant = (e: Event, origin: ModelOrigin) => {
    if (group && !sameOrigin(group.origin, origin)) flush()
    if (!group) {
      settleAwaiting()
      group = { origin, content: [], at: e.at }
    }
    return group
  }

  for (const raw of input.events) {
    const e = raw as CoreEvent
    switch (e.type) {
      case "core.user_message": {
        flush()
        const c = content(e, e.payload.content)
        const msg: Message = { role: "user", content: toPiContent(c.parts), timestamp: e.at }
        // 工具结果还没到齐就来了用户消息：后移到同批结果之后，否则 tool_use 后面紧跟的不是 tool_result，厂商 400。
        // 顺序变了所以记 lossy；日志里它仍在原位
        if (awaiting.size > 0) {
          deferred.push({
            msg,
            event: e,
            kind: "lossy",
            landing: "user",
            note: c.escaped
              ? `the user message sits between a tool call and its results; ${ESCAPED_NOTE}`
              : "the user message sits between a tool call and its results",
          })
          break
        }
        messages.push(msg)
        if (c.escaped) land(e, "lossy", "user", ESCAPED_NOTE)
        else land(e, "exact", "user")
        break
      }

      case "core.model_thinking": {
        const origin = originOf(e.replay, model)
        const r = (e.replay ?? {}) as ThinkingReplay
        const block: ThinkingContent = { type: "thinking", thinking: e.payload.text }
        if (typeof r.thinkingSignature === "string") block.thinkingSignature = r.thinkingSignature
        if (r.redacted === true) block.redacted = true
        assistant(e, origin).content.push(block)
        if (!block.thinkingSignature)
          land(e, "lossy", "text-or-drop", "pi-ai downgrades unsigned thinking to text or drops it")
        else if (foreignOrigin(origin, target))
          land(
            e,
            "lossy",
            "provider-dependent",
            `thinking from ${origin.provider}/${origin.model}, which the provider may ignore or reject`,
          )
        else if (origin.model !== target.model)
          land(
            e,
            "exact",
            isAnthropic ? "thinking-block" : "reasoning-item",
            `the signature comes from ${origin.model}, but this request targets ${target.model}`,
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
        if (wrapped) land(e, "lossy", "wrapped-args", "non-object arguments are wrapped as { value }")
        else land(e, "exact", isAnthropic ? "tool_use" : "function_call")
        break
      }

      case "core.tool_result": {
        flush()
        const c = content(e, e.payload.content)
        messages.push({
          role: "toolResult",
          toolCallId: e.payload.toolCallId,
          toolName: e.payload.name,
          content: toPiContent(c.parts),
          isError: e.payload.isError,
          timestamp: e.at,
        })
        const landing = isAnthropic ? "tool_result" : "function_call_output"
        if (c.escaped) land(e, "lossy", landing, ESCAPED_NOTE)
        else land(e, "exact", landing)
        awaiting.delete(e.payload.toolCallId)
        if (awaiting.size === 0) releaseDeferred()
        break
      }

      case "core.system_note": {
        flush()
        // 宿主注入的外部内容可能把 system_note 标成 untrusted（如抓取的网页），同样包裹
        const t = text(e, e.payload.text)
        if (capabilities.midConversationSystem) {
          note(
            e,
            { role: "user", content: markSystemNote(t.text), timestamp: e.at },
            t.escaped ? "lossy" : "exact",
            isAnthropic ? "system" : model.reasoning ? "developer" : "system",
            t.escaped ? ESCAPED_NOTE : undefined,
          )
        } else {
          note(
            e,
            { role: "user", content: framedSystemNote(e.payload.kind, t.text), timestamp: e.at },
            "lossy",
            "user-role",
            "the model does not support mid-conversation system, so it is wrapped in a <system_note> tag and sent with the user role",
          )
        }
        break
      }

      case "core.compaction": {
        flush()
        const t = text(e, e.payload.summary)
        note(
          e,
          {
            role: "user",
            content: `[Summary of earlier conversation]\n${t.text}`,
            timestamp: e.at,
          },
          "lossy",
          "user-text",
          "the summary is rendered as user-role text",
        )
        break
      }

      case "core.approval_request":
      case "core.approval_decision":
      case "core.run_paused":
      case "core.run_resumed":
      case "core.budget_usage":
      case "core.memory_op":
      case "core.handoff":
      case "core.error":
        land(e, "dropped", "none", "operational event, not sent (the default projection already filters it)")
        break

      default:
        land(raw, "dropped", "none", `no general landing for ${raw.type}`)
    }
  }
  flush()
  settleAwaiting()

  const context: Context = { messages }
  if (input.systemPrompt) context.systemPrompt = input.systemPrompt
  // deferLoading 的工具不发（没有"声明但不载入"的落点；L1）
  const shownTools = (input.tools ?? []).filter((t) => t.deferLoading !== true)
  if (shownTools.length > 0) {
    // pi-ai 的 parameters 是 typebox TSchema，运行时就是 JSON Schema 对象，直接透传
    context.tools = shownTools.map(
      (t): Tool => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Tool["parameters"],
      }),
    )
  }
  return { context, landings }
}
