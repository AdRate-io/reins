/**
 * system_note 的落点（S1 结论）。
 *
 * pi-ai 的 Message 没有 system 角色，所以：
 * - 模型支持中途 system 时：先当 user 消息放进 Context，文本前加内部标记；在 pi-ai 的 onPayload 钩子里
 *   把带标记的消息改写成线协议的 system 消息并归位。标记只在本文件生产与消费，不会送到线上。
 * - 不支持时：以 <system_note> 标签包住、仍走 user 角色，有损矩阵记为 lossy(user-role)。
 *
 * Anthropic 摆放规则（官方，违反即 400）：不能是首条；必须紧跟 user 轮（含 tool_result 的 user）；
 * 后接 assistant 或收尾；连续多条 system 视为一组。
 * OpenAI Responses：input 项里 developer / system 消息可出现在任意位置，无归位需求。
 */
import type { SystemNotePayload } from "@reinsjs/core"

export const SYSTEM_NOTE_MARK = "[[reins:system_note]]"

export function markSystemNote(text: string): string {
  return `${SYSTEM_NOTE_MARK}${text}`
}

/** 不支持中途 system 的模型：用标签框住，让模型知道这不是用户说的 */
export function framedSystemNote(kind: SystemNotePayload["kind"], text: string): string {
  return `<system_note kind="${kind}">\n${text}\n</system_note>`
}

interface WireMessage {
  role: string
  content: unknown
  [k: string]: unknown
}

interface MarkedNote {
  text: string
  /** pi-ai 打在这条消息上的缓存断点（它是最后一条 user 时才有），改写后要搬走而不是丢掉 */
  cacheControl?: unknown
}

/** 取出带标记的正文；不是标记消息返回 null */
function markedNote(m: WireMessage, textType: string): MarkedNote | null {
  if (m.role !== "user") return null
  let text: string | null = null
  let cacheControl: unknown
  if (typeof m.content === "string") text = m.content
  else if (Array.isArray(m.content) && m.content.length === 1) {
    const only = m.content[0] as { type?: string; text?: string; cache_control?: unknown }
    if (only.type === textType && typeof only.text === "string") {
      text = only.text
      cacheControl = only.cache_control
    }
  }
  if (text === null || !text.startsWith(SYSTEM_NOTE_MARK)) return null
  return {
    text: text.slice(SYSTEM_NOTE_MARK.length),
    ...(cacheControl !== undefined ? { cacheControl } : {}),
  }
}

/**
 * Anthropic Messages 请求体改写：标记消息 → {role:"system", content:[text]}，并按摆放规则归位。
 * 归位算法：每条 system 放到"它之后的第一条 assistant"之前（此时前一条必是 user）；后面没有 assistant 就放到
 * 消息列表末尾（紧跟最后一条 user 收尾）。pi-ai 在部分模型上会在末尾追加 content 为空的 effort 专用 system 消息，
 * 我们的 system 与它相邻成组，符合规则。
 *
 * 缓存断点（B1，prompt cache 约束 4）：pi-ai 把 cache_control 打在"最后一条 user 消息"上；感知等 system_note
 * 追加在时间线末尾时，那条最后的 user 正是我们的标记消息，改写成 system 后断点会跟着消失，而官方规则是
 * "最后一个断点之后的内容一律不缓存" —— 整段对话历史都会按原价计费。处置由 `cacheBreakpoint` 选：
 * - "automatic"（缺省）：去掉这个块级断点，在请求顶层补 `cache_control`（Anthropic 的自动缓存：断点自动落在最后一个
 *   可缓存块上，与显式断点兼容、占 4 个槽位中的 1 个）。B1 实测（spikes/b1-perception-cache）命中率与不注入持平。
 * - "previous-user"：搬到紧邻的前一条 user 消息末块（真正的最新 user / tool_result）。实测比不注入低 3~6 个点。
 * - "drop"：丢掉。只在上游自己会补自动缓存（如某些网关）时才不吃亏。
 * 把断点留在改写后的 system 消息上实测会让整段提示每次重写、几乎零命中，所以不提供这个选项。
 */
export type MidSystemCacheBreakpoint = "automatic" | "previous-user" | "drop"

export interface RewriteAnthropicOptions {
  cacheBreakpoint?: MidSystemCacheBreakpoint
}

/** Anthropic 每个请求最多 4 个断点（含顶层自动缓存那一个），超出即 400 */
const MAX_ANTHROPIC_BREAKPOINTS = 4

export function rewriteAnthropicPayload(payload: unknown, opts: RewriteAnthropicOptions = {}): unknown {
  const breakpoint = opts.cacheBreakpoint ?? "automatic"
  const p = payload as {
    messages?: WireMessage[]
    system?: unknown
    tools?: unknown
    cache_control?: unknown
  }
  if (!Array.isArray(p.messages)) return undefined
  const body: WireMessage[] = []
  const pending: (MarkedNote & { afterIndex: number })[] = []
  for (const m of p.messages) {
    const note = markedNote(m, "text")
    if (note !== null) pending.push({ ...note, afterIndex: body.length })
    else body.push(m)
  }
  if (pending.length === 0) return undefined

  // 每条说明在**原始** body 里的落点（都算完再拼，而不是边算边 splice：边 splice 会让同一落点的多条说明前后颠倒）
  const placeOf = (note: (typeof pending)[number]): number => {
    let at = body.findIndex((m, idx) => idx >= note.afterIndex && m.role === "assistant")
    if (at === -1) {
      // 收尾：跳过 pi-ai 追加的 effort 专用空 system，保持"紧跟最后一条 user"
      at = body.length
      while (at > 0 && body[at - 1]?.role === "system" && isEmptyContent(body[at - 1]?.content)) at--
    }
    // 不能是首条：前面没有任何消息时挪到第一条 user 之后
    if (at === 0) {
      const firstUser = body.findIndex((m) => m.role === "user")
      at = firstUser === -1 ? body.length : firstUser + 1
    }
    return at
  }
  // 同一落点的说明按原顺序成组（相邻的多条 system 视为一组，Anthropic 允许）
  const groups = new Map<number, MarkedNote[]>()
  for (const note of pending) {
    const at = placeOf(note)
    const bucket = groups.get(at)
    if (bucket) bucket.push(note)
    else groups.set(at, [note])
  }

  let lostBreakpoint: unknown
  const messages: WireMessage[] = []
  for (let i = 0; i <= body.length; i++) {
    const notes = groups.get(i)
    if (notes) {
      for (const note of notes) {
        if (note.cacheControl !== undefined && breakpoint === "previous-user") {
          // 搬到紧邻的前一条 user 消息末块（此时它已在 messages 末尾）
          const prev = messages[messages.length - 1]
          if (prev) messages[messages.length - 1] = withCacheControl(prev, note.cacheControl)
        }
        if (note.cacheControl !== undefined && breakpoint === "automatic") lostBreakpoint = note.cacheControl
        messages.push({ role: "system", content: [{ type: "text", text: note.text }] })
      }
    }
    const m = body[i]
    if (m) messages.push(m)
  }
  const out = { ...p, messages }
  if (lostBreakpoint !== undefined && out.cache_control === undefined) {
    // 顶层自动缓存也占一个槽位；块级断点已满就只能放弃，不能让请求 400
    if (countBlockBreakpoints(out) < MAX_ANTHROPIC_BREAKPOINTS) out.cache_control = lostBreakpoint
  }
  return out
}

/** 数请求里块级 cache_control 的个数：system 数组、tools 数组、messages 的内容块 */
function countBlockBreakpoints(p: { system?: unknown; tools?: unknown; messages: WireMessage[] }): number {
  const has = (b: unknown) => typeof b === "object" && b !== null && "cache_control" in b
  let n = 0
  if (Array.isArray(p.system)) n += p.system.filter(has).length
  if (Array.isArray(p.tools)) n += p.tools.filter(has).length
  for (const m of p.messages) if (Array.isArray(m.content)) n += m.content.filter(has).length
  return n
}

/**
 * 把缓存断点打到某条 user 消息的最后一个内容块上（Anthropic 允许 text / image / tool_result 块带 cache_control）。
 * 归位规则保证 system 前面必是 user；万一不是，宁可丢断点也不把 cache_control 放到厂商不认的位置上。
 * 返回新对象，不改动传入的请求体。
 */
function withCacheControl(m: WireMessage, cacheControl: unknown): WireMessage {
  if (m.role !== "user") return m
  if (typeof m.content === "string") {
    return { ...m, content: [{ type: "text", text: m.content, cache_control: cacheControl }] }
  }
  if (Array.isArray(m.content) && m.content.length > 0) {
    const blocks = [...(m.content as Record<string, unknown>[])]
    const last = blocks[blocks.length - 1] as Record<string, unknown>
    blocks[blocks.length - 1] = { ...last, cache_control: cacheControl }
    return { ...m, content: blocks }
  }
  return m
}

function isEmptyContent(content: unknown): boolean {
  return Array.isArray(content) && content.length === 0
}

/**
 * OpenAI Responses 请求体改写：标记消息 → {role: developer|system, content:[input_text]}。
 * reasoning 模型用 developer（与 pi-ai 放 systemPrompt 的选择一致），其余用 system。
 */
export function rewriteOpenAIResponsesPayload(payload: unknown, model: { reasoning: boolean }): unknown {
  const p = payload as { input?: unknown }
  if (!Array.isArray(p.input)) return undefined
  let changed = false
  const role = model.reasoning ? "developer" : "system"
  const input = (p.input as WireMessage[]).map((m) => {
    const note = markedNote(m, "input_text")
    if (note === null) return m
    changed = true
    return { role, content: [{ type: "input_text", text: note.text }] }
  })
  return changed ? { ...p, input } : undefined
}
