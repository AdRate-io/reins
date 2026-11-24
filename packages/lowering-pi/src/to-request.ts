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
  isImageRef,
  type LandingRecord,
  type LoweringCapabilities,
  markUntrusted,
  markUntrustedText,
  needsUntrustedMark,
  renderToolReference,
  type SystemNotePayload,
  type ToolSpec,
  untrustedSourceOf,
} from "@reinsjs/core"
import { IMAGE_OMITTED_NOTE, IMAGE_UNAVAILABLE_NOTE, MEDIA_PLACEHOLDER_NOTE } from "./loss-matrix.js"
import type { PiModel } from "./models.js"
import { framedSystemNote, markSystemNote, midSystemSlotFollowsUser, midSystemSlotOf } from "./system-note.js"

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

/** pi-ai 0.85.1 没有视频 / 音频内容，这两种片段一律换占位并记 lossy（2026-11-05 视频音频方案） */
const MEDIA_NOTE = MEDIA_PLACEHOLDER_NOTE

function mediaPlaceholder(p: Extract<ContentPart, { type: "video" | "audio" }>): string {
  const sec =
    p.durationSec === undefined
      ? ""
      : `, ${Number.isInteger(p.durationSec) ? p.durationSec : p.durationSec.toFixed(1)} s`
  return `[${p.type} omitted: this model does not accept ${p.type} (${p.mime}${sec})]`
}

/**
 * 未换回的图片引用的占位（2026-11-24 媒体引用方案）：循环在调降级层前已把视野内的引用换回内联，
 * 只有 blob 不在了（被清理、没配 BlobStore）才以引用形态到这里。与 fetch 版同一句
 */
const IMAGE_UNAVAILABLE = "[image unavailable]"

/**
 * 模型不收图时的占位（全库审查 2026-11-25 #34）。不交给 pi-ai：它的 downgradeUnsupportedImages 会静默换成
 * 自己的一句、落点却还是 exact。文案与 lowering-fetch 逐字一致
 */
const IMAGE_OMITTED = "[image omitted: this model does not accept images]"

function toPiContent(
  parts: readonly ContentPart[],
  capabilities: LoweringCapabilities,
): {
  content: (TextContent | { type: "image"; data: string; mimeType: string })[]
  /** 有片段被换成占位时的落点说明（模型不收的图片、视频 / 音频、未换回的图片引用）；没有为 undefined */
  mediaNote: string | undefined
} {
  let mediaDropped = false
  let unavailable = false
  let imageOmitted = false
  const content = parts.map((p): TextContent | { type: "image"; data: string; mimeType: string } => {
    switch (p.type) {
      case "text":
        return { type: "text", text: p.text }
      // 工具引用段（L1）：pi-ai 的请求整形改不了，没有 defer_loading 落点，展开成文本
      case "tool_reference":
        return { type: "text", text: renderToolReference(p) }
      case "image":
        if (isImageRef(p)) {
          unavailable = true
          return { type: "text", text: IMAGE_UNAVAILABLE }
        }
        if (!capabilities.images) {
          imageOmitted = true
          return { type: "text", text: IMAGE_OMITTED }
        }
        return { type: "image", data: p.data, mimeType: p.mime }
      case "video":
      case "audio":
        mediaDropped = true
        return { type: "text", text: mediaPlaceholder(p) }
      default: {
        const _exhaustive: never = p
        return _exhaustive
      }
    }
  })
  const notes = [
    imageOmitted ? IMAGE_OMITTED_NOTE : undefined,
    mediaDropped ? MEDIA_NOTE : undefined,
    unavailable ? IMAGE_UNAVAILABLE_NOTE : undefined,
  ]
  const mediaNote = notes.filter(Boolean).join("; ")
  return { content, mediaNote: mediaNote.length > 0 ? mediaNote : undefined }
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

const TEXT_SIGNATURE_NOTE =
  "the message id and phase recorded with this text are not replayed for another model"
const NAMESPACE_NOTE = "the tool namespace is not replayed for another model"

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
  /**
   * 中途 system 说明的内部标记（发出前由 onPayload 改写时按它认）。PiAiLowering 每个请求传一枚 `newSystemNoteMark()`；
   * 缺省静态 `SYSTEM_NOTE_MARK`，只供独立调用——此时用户文本以它开头会被当成说明（全库审查 2026-11-25 #3）
   */
  systemNoteMark?: string
}

interface MidSystemNote {
  msg: Message
  event: Event
  kind: SystemNotePayload["kind"]
  /** 已做过 trust 标注的正文（不含标记） */
  text: string
}

const MISPLACED_NOTE =
  "no user turn precedes the note's place (it would follow the model's answer), and Anthropic rejects a mid-conversation system message there, so it is wrapped in a <system_note> tag and sent with the user role"

/**
 * Anthropic 中途 system 的落点预判（全库审查 2026-11-25 #32）：发出前的改写只能把说明挪到下一条 assistant 之前或末尾，
 * 落点前一条若是 assistant（上个 run 以纯文本收尾、新 run 只带说明；说明夹在两段 assistant 之间）厂商 400，
 * 而日志只追加、每轮整段回放，会一直 400。这里用改写同一个归位函数预判，不合法的就地换成带标签的 user、落点改记
 * lossy(user-role)——与 lowering-fetch 的 Anthropic 线同一取向。按时间线顺序逐条判：退回 user 的说明成为普通
 * user 消息，后面同一落点的说明就紧跟它、可以照常走 system，与改写时看到的请求体一致。
 * pi-ai 若在发出时额外丢掉某条 assistant，只会让前一条更可能是 user，预判偏保守，不会放过非法形状。
 */
function fallBackMisplacedNotes(
  messages: Message[],
  landings: LandingRecord[],
  notes: readonly MidSystemNote[],
): void {
  const marked = new Set<Message>(notes.map((n) => n.msg))
  for (const n of notes) {
    const idx = messages.indexOf(n.msg)
    if (idx === -1) continue
    const body = messages.filter((m) => !marked.has(m))
    const afterIndex = messages.slice(0, idx).filter((m) => !marked.has(m)).length
    if (midSystemSlotFollowsUser(body, midSystemSlotOf(body, afterIndex))) continue
    marked.delete(n.msg)
    messages[idx] = { ...n.msg, content: framedSystemNote(n.kind, n.text) } as Message
    const rec = landings.find((l) => l.eventId === n.event.id)
    if (rec) {
      rec.kind = "lossy"
      rec.landing = "user-role"
      rec.note = rec.note ? `${MISPLACED_NOTE}; ${rec.note}` : MISPLACED_NOTE
    }
  }
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
  /** Anthropic 线上要改写成中途 system 的说明（按时间线顺序），收尾时预判归位、落不到 user 之后的退回 user */
  const midSystemNotes: MidSystemNote[] = []
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
        const pc = toPiContent(c.parts, capabilities)
        const msg: Message = { role: "user", content: pc.content, timestamp: e.at }
        const mediaNote = pc.mediaNote
        // 工具结果还没到齐就来了用户消息：后移到同批结果之后，否则 tool_use 后面紧跟的不是 tool_result，厂商 400。
        // 顺序变了所以记 lossy；日志里它仍在原位
        if (awaiting.size > 0) {
          deferred.push({
            msg,
            event: e,
            kind: "lossy",
            landing: "user",
            note: [
              "the user message sits between a tool call and its results",
              c.escaped ? ESCAPED_NOTE : undefined,
              mediaNote,
            ]
              .filter(Boolean)
              .join("; "),
          })
          break
        }
        messages.push(msg)
        if (c.escaped || mediaNote)
          land(
            e,
            "lossy",
            "user",
            [c.escaped ? ESCAPED_NOTE : undefined, mediaNote].filter(Boolean).join("; "),
          )
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
        // 判据与 pi-ai 回放时的 isSameModel 逐字同口径（transform-messages：provider + api + model 三者相等）：
        // 不同就由 pi-ai 改写——带签名的思考降成纯文本，redacted 或正文为空的整块丢掉。
        // Anthropic 线的型号 id 取自厂商回报（Responses 线取请求的 id，不漂移）。2026-11-24 只实测了 DeepSeek
        // Anthropic 端口与官方 Haiku 5.5 两处，回报与请求逐字一致（spikes/pi-reported-model）；请求别名而厂商回报
        // 带日期的 id、或经改名的中转站时未测——那时每轮都会降级，这里如实记有损，不假装 exact。
        else if (!sameOrigin(origin, target)) {
          if (block.redacted === true || block.thinking.trim() === "")
            land(
              e,
              "dropped",
              "none",
              `pi-ai drops redacted or empty thinking from ${origin.provider}/${origin.model}`,
            )
          else
            land(
              e,
              "lossy",
              "as-text",
              `thinking from ${origin.provider}/${origin.model} is replayed as plain text; pi-ai replays signatures only for the same provider, api and model`,
            )
        } else land(e, "exact", isAnthropic ? "thinking-block" : "reasoning-item")
        break
      }

      case "core.model_text": {
        const origin = originOf(e.replay, model)
        const r = (e.replay ?? {}) as TextReplay
        const block: TextContent = { type: "text", text: e.payload.text }
        if (typeof r.textSignature === "string") block.textSignature = r.textSignature
        assistant(e, origin).content.push(block)
        // pi-ai 对非同源（三者任一不同）的正文只留文字、剥掉 textSignature；Responses 线靠它回放消息 id 与 phase
        // （commentary / final_answer），没了就退成 msg_pi_N、phase 丢失。Anthropic 线不用它，照旧 exact
        if (!isAnthropic && !sameOrigin(origin, target) && typeof r.textSignature === "string")
          land(e, "lossy", "assistant-message", TEXT_SIGNATURE_NOTE)
        else land(e, "exact", isAnthropic ? "assistant-text" : "assistant-message")
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
        // Responses 线换型号：pi-ai 只对同型号回放 namespace（lowering-pi 不开 deferredTools），fc_ 项 id 也不再回放；
        // 前者改变工具归属记 lossy，后者只影响与推理项的配对校验、语义无损，exact 加备注
        const otherModel = !isAnthropic && !sameOrigin(origin, target)
        if (wrapped) land(e, "lossy", "wrapped-args", "non-object arguments are wrapped as { value }")
        else if (otherModel && typeof r.namespace === "string")
          land(e, "lossy", "function_call", NAMESPACE_NOTE)
        else if (otherModel && e.payload.toolCallId.includes("|fc_"))
          land(e, "exact", "function_call", "the fc_ item id is not replayed for another model")
        else land(e, "exact", isAnthropic ? "tool_use" : "function_call")
        break
      }

      case "core.tool_result": {
        flush()
        const c = content(e, e.payload.content)
        const pc = toPiContent(c.parts, capabilities)
        messages.push({
          role: "toolResult",
          toolCallId: e.payload.toolCallId,
          toolName: e.payload.name,
          content: pc.content,
          isError: e.payload.isError,
          timestamp: e.at,
        })
        const landing = isAnthropic ? "tool_result" : "function_call_output"
        if (c.escaped || pc.mediaNote)
          land(
            e,
            "lossy",
            landing,
            [c.escaped ? ESCAPED_NOTE : undefined, pc.mediaNote].filter(Boolean).join("; "),
          )
        else land(e, "exact", landing)
        awaiting.delete(e.payload.toolCallId)
        if (awaiting.size === 0) releaseDeferred()
        break
      }

      case "core.system_note": {
        flush()
        // 宿主注入的外部内容可能把 system_note 标成 untrusted（如抓取的网页），同样包裹
        const t = text(e, e.payload.text)
        // 指令类说明（directive）不走中途 system：有的上游收下却不执行其中的指令（踩坑 42），一律带标签走 user
        if (capabilities.midConversationSystem && e.payload.directive !== true) {
          const msg: Message = {
            role: "user",
            content: markSystemNote(t.text, input.systemNoteMark),
            timestamp: e.at,
          }
          if (isAnthropic) midSystemNotes.push({ msg, event: e, kind: e.payload.kind, text: t.text })
          note(
            e,
            msg,
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
            e.payload.directive === true
              ? "the note is a directive the model must act on, so it is wrapped in a <system_note> tag and sent with the user role"
              : "the model does not support mid-conversation system, so it is wrapped in a <system_note> tag and sent with the user role",
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
      case "core.tool_started":
      case "core.run_ended":
      case "core.error":
        land(e, "dropped", "none", "operational event, not sent (the default projection already filters it)")
        break

      default:
        land(raw, "dropped", "none", `no general landing for ${raw.type}`)
    }
  }
  flush()
  settleAwaiting()
  if (midSystemNotes.length > 0) fallBackMisplacedNotes(messages, landings, midSystemNotes)

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
