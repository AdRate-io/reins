/**
 * 事件 ⇄ TanStack `ModelMessage` 的翻译（角色只在这里出现 —— 宪法二）。
 *
 * 出口 `toModelMessages`：投影后的事件 → 交给 TanStack 适配器的 `providerMessages`，每条事件记一条落点。
 * TanStack 的 ModelMessage 只有 user / assistant / tool 三种角色、assistant 正文是单个字符串，所以：
 * - system_note 只能以 `<system_note kind=…>` 标签包住走 user 角色（lossy，与 lowering-pi 对不支持中途 system 的模型同一做法）
 * - compaction 摘要走 user 文本（lossy）
 * - 同一响应里多段 model_text 合成一个字符串（lossy，只在多段时）
 * - thinking 只在签名来自同一 provider/model 时回放；无签名或来源不同一律不下发（dropped），
 *   因为多数厂商会拒收无签名的 thinking 块，让适配器崩掉比丢一段思考更糟
 * - 运维事件（审批、预算、暂停等）不下发（投影默认已过滤，这里兜底记 dropped）
 *
 * 入口 `importModelMessages`：客户端发来的 ModelMessage → 事件草稿，首次接入或续接新用户消息时用。
 * 每条草稿的 `provenance.ref` 是幂等键（`importRef`）：客户端消息自带 `id` 就用 id，否则用它在客户端数组里的位置；
 * `dedupeImportedUserMessages` 据此把网络重试重发的用户消息挡在日志外（R5）。
 */
import {
  type CoreEvent,
  type Event,
  type EventDraft,
  type LandingRecord,
  type ModelRef,
  markUntrusted,
  markUntrustedText,
  needsUntrustedMark,
  type ContentPart as ReinsPart,
  type ToolCallPayload,
  untrustedSourceOf,
} from "@reinsjs/core"
import type { ModelMessage, ToolCall as TanstackToolCall } from "@tanstack/ai"
import { fromTanstackContent, toTanstackContent } from "./content.js"

export interface ToModelMessagesOptions {
  /** 当前请求的模型；thinking 签名只对同一来源回放 */
  model: ModelRef
  /** trust 标注（§14）：untrusted 的内容包 <untrusted source=…>，与 lowering-pi 同一份 core 函数。缺省 true */
  trustMarkers?: boolean
}

export interface LoweredMessages {
  messages: ModelMessage[]
  landings: LandingRecord[]
}

/** 不支持中途 system 的模型：用标签框住，让模型知道这不是用户说的（与 lowering-pi 的 framedSystemNote 同形） */
export function framedSystemNote(kind: string, text: string): string {
  return `<system_note kind="${kind}">\n${text}\n</system_note>`
}

export const COMPACTION_PREFIX = "[Summary of earlier conversation]\n"

interface AssistantGroup {
  texts: string[]
  thinking: { content: string; signature?: string }[]
  toolCalls: TanstackToolCall[]
  /** 多段正文合并时要补记 lossy 的事件 */
  textEvents: Event[]
}

/**
 * 工具调用与结果之间不能插别的消息（Anthropic 要求 tool_result 紧跟 tool_use 所在的 assistant 之后），
 * 而日志里 pin / memory 等留痕、感知说明都可能落在 tool_call 与 tool_result 之间。翻译时把这段里的
 * user 角色说明后移到同批工具结果之后，落点记录里注明。
 */
const DEFERRED_NOTE = "已后移到同批工具结果之后（工具结果必须紧跟调用）"
const ESCAPED_NOTE = "不可信内容里含提前闭合的 </untrusted，已转义"

interface DeferredNote {
  msg: ModelMessage
  event: Event
  landing: string
  note: string
}

/** 事件 → TanStack ModelMessage[]（纯函数） */
export function toModelMessages(events: readonly Event[], opts: ToModelMessagesOptions): LoweredMessages {
  const messages: ModelMessage[] = []
  const landings: LandingRecord[] = []
  let group: AssistantGroup | undefined
  /** 已下发 tool_call、还没见到结果的调用 id；非空时 user 角色说明要后移 */
  const awaiting = new Set<string>()
  const deferred: DeferredNote[] = []
  const trustMarkers = opts.trustMarkers !== false
  /** trust 标注：untrusted 的片段包上标记，事件本身不动；内容里有提前闭合被转义时 escaped=true（落点记 lossy） */
  const content = (
    e: Event,
    parts: readonly ReinsPart[],
  ): { parts: readonly ReinsPart[]; escaped: boolean } =>
    trustMarkers && needsUntrustedMark(e)
      ? markUntrusted(parts, untrustedSourceOf(e))
      : { parts, escaped: false }
  const text = (e: Event, s: string): { text: string; escaped: boolean } =>
    trustMarkers && needsUntrustedMark(e)
      ? markUntrustedText(s, untrustedSourceOf(e))
      : { text: s, escaped: false }

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
      land(d.event, "lossy", d.landing, `${d.note}；${DEFERRED_NOTE}`)
    }
    deferred.length = 0
  }
  /** user 角色的说明：工具结果还没到齐就先攒着 */
  const note = (e: Event, msg: ModelMessage, landing: string, why: string) => {
    if (awaiting.size > 0) {
      deferred.push({ msg, event: e, landing, note: why })
      return
    }
    messages.push(msg)
    land(e, "lossy", landing, why)
  }
  /** 新的 assistant 内容到来：这批调用的结果不会再来了（视图被切在了结果之前），后移的一切放出 */
  const settleAwaiting = () => {
    awaiting.clear()
    releaseDeferred()
  }
  const flush = () => {
    if (!group) return
    const g = group
    group = undefined
    if (g.texts.length === 0 && g.thinking.length === 0 && g.toolCalls.length === 0) return
    const msg: ModelMessage = { role: "assistant", content: g.texts.length > 0 ? g.texts.join("\n\n") : null }
    if (g.thinking.length > 0) msg.thinking = g.thinking
    if (g.toolCalls.length > 0) msg.toolCalls = g.toolCalls
    messages.push(msg)
    for (const c of g.toolCalls) awaiting.add(c.id)
    if (g.textEvents.length > 1)
      for (const e of g.textEvents) land(e, "lossy", "merged-text", "同一响应的多段正文合成一个字符串")
    else for (const e of g.textEvents) land(e, "exact", "assistant-text")
  }
  const assistant = (): AssistantGroup => {
    if (!group) {
      settleAwaiting()
      group = { texts: [], thinking: [], toolCalls: [], textEvents: [] }
    }
    return group
  }

  for (const raw of events) {
    const e = raw as CoreEvent
    switch (e.type) {
      case "core.user_message": {
        flush()
        const c = content(e, e.payload.content)
        const msg: ModelMessage = { role: "user", content: toTanstackContent(c.parts) }
        // 工具结果还没到齐就来了用户消息（续跑带新输入、进程死亡后再发）：后移到同批结果之后，与 lowering-pi 同一规则
        if (awaiting.size > 0) {
          deferred.push({
            msg,
            event: e,
            landing: "user",
            note: c.escaped
              ? `用户消息落在工具调用与结果之间；${ESCAPED_NOTE}`
              : "用户消息落在工具调用与结果之间",
          })
          break
        }
        messages.push(msg)
        if (c.escaped) land(e, "lossy", "user", ESCAPED_NOTE)
        else land(e, "exact", "user")
        break
      }

      case "core.model_text":
        assistant().texts.push(e.payload.text)
        assistant().textEvents.push(e)
        break

      case "core.model_thinking": {
        const r = (e.replay ?? {}) as { provider?: unknown; model?: unknown; thinkingSignature?: unknown }
        const sameOrigin = r.provider === opts.model.provider && r.model === opts.model.id
        if (typeof r.thinkingSignature === "string" && sameOrigin) {
          assistant().thinking.push({ content: e.payload.text, signature: r.thinkingSignature })
          land(e, "exact", "thinking")
        } else if (typeof r.thinkingSignature === "string") {
          land(
            e,
            "dropped",
            "none",
            `签名来自 ${String(r.provider)}/${String(r.model)}，当前请求 ${opts.model.provider}/${opts.model.id}，不回放`,
          )
        } else {
          land(e, "dropped", "none", "无签名的 thinking 不下发（厂商会拒收）")
        }
        break
      }

      case "core.tool_call": {
        const r = (e.replay ?? {}) as { thoughtSignature?: unknown }
        const call: TanstackToolCall = {
          id: e.payload.toolCallId,
          type: "function",
          function: { name: e.payload.name, arguments: JSON.stringify(e.payload.args ?? {}) },
        }
        if (typeof r.thoughtSignature === "string") call.metadata = { thoughtSignature: r.thoughtSignature }
        assistant().toolCalls.push(call)
        land(e, "exact", "tool-call")
        break
      }

      case "core.tool_result": {
        flush()
        const c = content(e, e.payload.content)
        const msg: ModelMessage = {
          role: "tool",
          toolCallId: e.payload.toolCallId,
          name: e.payload.name,
          content: toTanstackContent(c.parts),
        }
        if (e.payload.isError) {
          msg.error = textOf(c.parts)
          land(
            e,
            "lossy",
            "tool-error-field",
            c.escaped
              ? `isError 只落在 ModelMessage.error 字段，是否告知模型取决于适配器；${ESCAPED_NOTE}`
              : "isError 只落在 ModelMessage.error 字段，是否告知模型取决于适配器",
          )
        } else if (c.escaped) land(e, "lossy", "tool", ESCAPED_NOTE)
        else land(e, "exact", "tool")
        messages.push(msg)
        awaiting.delete(e.payload.toolCallId)
        if (awaiting.size === 0) releaseDeferred()
        break
      }

      case "core.system_note":
        flush()
        note(
          e,
          { role: "user", content: framedSystemNote(e.payload.kind, text(e, e.payload.text).text) },
          "user-role",
          "TanStack 消息无 system 角色，以 <system_note> 标签包住走 user",
        )
        break

      case "core.compaction":
        flush()
        note(
          e,
          { role: "user", content: `${COMPACTION_PREFIX}${text(e, e.payload.summary).text}` },
          "user-text",
          "摘要以 user 角色文本呈现",
        )
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
  releaseDeferred()
  return { messages, landings }
}

function textOf(parts: readonly ReinsPart[]): string {
  return parts.map((p) => (p.type === "text" ? p.text : `[image ${p.mime}]`)).join("\n")
}

// ---- 入口：客户端历史 → 事件草稿 ----

export interface ImportOrigin {
  provider: string
  api: string
  model: string
}

export interface ImportedMessages {
  drafts: EventDraft[]
  /** 未能翻译的片段（类型名），供告警 */
  dropped: string[]
}

export interface ImportOptions {
  /**
   * `messages[0]` 在客户端完整消息数组里的下标。只导入末尾新消息时必须传，否则位置键会从 0 起算，
   * 与首次整段导入时的键撞上（撞上也只是多比一次内容，不会误删）
   */
  startIndex?: number
}

/** 导入来源标识（`provenance.source`） */
export const IMPORT_SOURCE = "tanstack-ai"

/**
 * 客户端消息的幂等键（R5），落在草稿的 `provenance.ref`：
 * - 客户端给了稳定 `id`（TanStack 持久化 / 水合会保留）→ `import:id:<id>`
 * - 没给 → `import:<index>`，index 是它在客户端完整消息数组里的位置。客户端每次都把整段历史连同新消息一起发来，
 *   数组只增不减，所以"同一位置 + 同一内容"就是同一条消息；客户端若自行裁剪历史，位置会漂，退化成不去重（今天的行为）
 */
export function importRef(message: ModelMessage, index: number): string {
  return message.id !== undefined && message.id !== "" ? `import:id:${message.id}` : `import:${index}`
}

/**
 * ModelMessage[] → 事件草稿。assistant 的 thinking 带签名时写进 replay（同 lowering-pi 的字段名），
 * tool 消息的工具名从前面的 toolCalls 反查；解析不了的入参原样存字符串。
 */
export function importModelMessages(
  messages: readonly ModelMessage[],
  origin: ImportOrigin,
  opts: ImportOptions = {},
): ImportedMessages {
  const drafts: EventDraft[] = []
  const dropped: string[] = []
  const names = new Map<string, string>()
  const startIndex = opts.startIndex ?? 0

  for (const [i, m] of messages.entries()) {
    const provenance = { source: IMPORT_SOURCE, ref: importRef(m, startIndex + i) }
    if (m.role === "user") {
      const c = fromTanstackContent(m.content)
      dropped.push(...c.dropped)
      drafts.push({ type: "core.user_message", actor: "user", payload: { content: c.parts }, provenance })
      continue
    }
    if (m.role === "assistant") {
      for (const t of m.thinking ?? []) {
        const replay: Record<string, unknown> = { ...origin }
        if (t.signature) replay.thinkingSignature = t.signature
        drafts.push({
          type: "core.model_thinking",
          actor: "model",
          payload: { text: t.content },
          replay,
          provenance,
        })
      }
      if (typeof m.content === "string" && m.content.length > 0)
        drafts.push({
          type: "core.model_text",
          actor: "model",
          payload: { text: m.content },
          replay: { ...origin },
          provenance,
        })
      else if (Array.isArray(m.content)) {
        const c = fromTanstackContent(m.content)
        dropped.push(...c.dropped)
        const text = c.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n")
        if (text)
          drafts.push({
            type: "core.model_text",
            actor: "model",
            payload: { text },
            replay: { ...origin },
            provenance,
          })
      }
      for (const call of m.toolCalls ?? []) {
        names.set(call.id, call.function.name)
        const payload: ToolCallPayload = {
          toolCallId: call.id,
          name: call.function.name,
          args: parseArgs(call.function.arguments),
        }
        drafts.push({ type: "core.tool_call", actor: "model", payload, replay: { ...origin }, provenance })
      }
      continue
    }
    if (m.role === "tool" && m.toolCallId) {
      const c = fromTanstackContent(m.content)
      dropped.push(...c.dropped)
      const name = names.get(m.toolCallId) ?? m.name ?? "unknown"
      drafts.push({
        type: "core.tool_result",
        actor: "tool",
        provenance: { source: name, ref: "tanstack-ai:import" },
        payload: { toolCallId: m.toolCallId, name, content: c.parts, isError: typeof m.error === "string" },
      })
    }
  }
  return { drafts, dropped }
}

/** 工具入参字符串 → JSON 值；解析失败原样存字符串（日志存模型给的原样，校验在执行前做） */
export function parseArgs(raw: string): unknown {
  const s = raw.trim()
  if (s === "") return {}
  try {
    return JSON.parse(s)
  } catch {
    return raw
  }
}

/**
 * 找出客户端这次新带来的用户消息：末尾连续的 user 消息（最后一条 assistant / tool 之后的）。
 * TanStack 客户端每次把整段历史连同新输入一起发来，历史部分日志里已经有了，只有这一截是新的。
 */
export function trailingUserMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  let i = messages.length
  while (i > 0 && messages[i - 1]?.role === "user") i--
  return messages.slice(i)
}

export interface DedupedDrafts {
  drafts: EventDraft[]
  /** 被判定为重发而跳过的用户消息条数 */
  skipped: number
}

/**
 * 导入前去重（R5）：草稿里的 `core.user_message` 若在日志里已有同源（`tanstack-ai`）、同幂等键、
 * 且内容逐字相同的一条，就是网络重试 / 客户端重放带来的重发，跳过不入日志。
 *
 * 键相同但内容不同一律当新消息导入——位置键在客户端裁剪历史后会漂到别的消息上，宁可多记一条也不能丢用户说过的话。
 * 内容比对用 `JSON.stringify`：两边都出自同一个翻译函数（键序一致），且 pg 侧刻意用 `json` 不用 `jsonb`（不重排键序），
 * 比不上的后果只是退化成不去重。非 user 草稿（整段接管时的 assistant / tool）原样放行，它们只在日志为空时才会被导入。
 */
export function dedupeImportedUserMessages(
  drafts: readonly EventDraft[],
  timeline: readonly Event[],
): DedupedDrafts {
  const seen = new Map<string, string>()
  for (const e of timeline) {
    if (
      e.type !== "core.user_message" ||
      e.provenance?.source !== IMPORT_SOURCE ||
      e.provenance.ref === undefined
    )
      continue
    seen.set(e.provenance.ref, JSON.stringify((e.payload as { content: unknown }).content))
  }
  let skipped = 0
  const kept: EventDraft[] = []
  for (const d of drafts) {
    const ref = d.provenance?.ref
    if (d.type === "core.user_message" && ref !== undefined) {
      const prior = seen.get(ref)
      if (prior !== undefined && prior === JSON.stringify((d.payload as { content: unknown }).content)) {
        skipped++
        continue
      }
    }
    kept.push(d)
  }
  return { drafts: kept, skipped }
}
