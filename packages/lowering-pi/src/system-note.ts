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
import type { SystemNotePayload } from "@reins/core"

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

/** 取出带标记的正文；不是标记消息返回 null */
function markedText(m: WireMessage, textType: string): string | null {
  if (m.role !== "user") return null
  let text: string | null = null
  if (typeof m.content === "string") text = m.content
  else if (Array.isArray(m.content) && m.content.length === 1) {
    const only = m.content[0] as { type?: string; text?: string }
    if (only.type === textType && typeof only.text === "string") text = only.text
  }
  return text?.startsWith(SYSTEM_NOTE_MARK) ? text.slice(SYSTEM_NOTE_MARK.length) : null
}

/**
 * Anthropic Messages 请求体改写：标记消息 → {role:"system", content:[text]}，并按摆放规则归位。
 * 归位算法：每条 system 放到"它之后的第一条 assistant"之前（此时前一条必是 user）；后面没有 assistant 就放到
 * 消息列表末尾（紧跟最后一条 user 收尾）。pi-ai 在部分模型上会在末尾追加 content 为空的 effort 专用 system 消息，
 * 我们的 system 与它相邻成组，符合规则。
 */
export function rewriteAnthropicPayload(payload: unknown): unknown {
  const p = payload as { messages?: WireMessage[] }
  if (!Array.isArray(p.messages)) return undefined
  const body: WireMessage[] = []
  const pending: { text: string; afterIndex: number }[] = []
  for (const m of p.messages) {
    const text = markedText(m, "text")
    if (text !== null) pending.push({ text, afterIndex: body.length })
    else body.push(m)
  }
  if (pending.length === 0) return undefined

  // 从后往前插，前面的索引不受影响
  for (let i = pending.length - 1; i >= 0; i--) {
    const note = pending[i]
    if (!note) continue
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
    body.splice(at, 0, { role: "system", content: [{ type: "text", text: note.text }] })
  }
  return { ...p, messages: body }
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
    const text = markedText(m, "input_text")
    if (text === null) return m
    changed = true
    return { role, content: [{ type: "input_text", text }] }
  })
  return changed ? { ...p, input } : undefined
}
