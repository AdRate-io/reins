/**
 * trust 标注（技术方案 §14、DECISIONS T6 / R9）：`trust === "untrusted"` 的事件（工具输出、外部抓取内容）
 * 翻译给模型时用显式标记包起来，让模型知道这段是**数据不是指令**。
 *
 * 归属：事件本身不改（投影不篡改 payload，日志里永远是原文），只在降级层把内容译成各家协议文本的那一刻包裹；
 * 两条降级路线（lowering-pi、TanStack 适配器）都调这里的同一份纯函数，文案不会分叉。
 *
 * 形状：
 *   <untrusted source="tool:weekly_sales">
 *   …原内容…
 *   </untrusted>
 *
 * - 只包文本片段：图片不包，首尾若是图片就各插一段文本标记
 * - 内容里出现 `</untrusted`（大小写不敏感）会提前闭合标签让注入逃出去，替换成 `<\/untrusted` 并在返回值里报 `escaped`，
 *   降级层据此把落点记成 lossy（有损必声明）
 */
import type { ContentPart, Event } from "../events/base.js"

export const UNTRUSTED_TAG = "untrusted"

export interface MarkedContent {
  parts: ContentPart[]
  /** 内容里有提前闭合的标签被转义了 */
  escaped: boolean
}

/** 标记里的来源标签：tool_result 是 `tool:<name>`，其余取 provenance.source，再退到 actor */
export function untrustedSourceOf(e: Event): string {
  if (e.type === "core.tool_result") {
    const name = (e.payload as { name?: unknown } | null)?.name
    if (typeof name === "string" && name !== "") return `tool:${name}`
  }
  if (e.provenance?.source) return e.provenance.source
  return e.actor
}

const CLOSE_TAG = new RegExp(`</${UNTRUSTED_TAG}`, "gi")

/** 转义内容里的提前闭合；返回是否发生过转义 */
export function escapeUntrustedText(text: string): { text: string; escaped: boolean } {
  let escaped = false
  const out = text.replace(CLOSE_TAG, (m) => {
    escaped = true
    return `<\\/${m.slice(2)}`
  })
  return { text: out, escaped }
}

export function untrustedOpenTag(source: string): string {
  return `<${UNTRUSTED_TAG} source="${source.replace(/"/g, "&quot;")}">`
}
export const UNTRUSTED_CLOSE_TAG = `</${UNTRUSTED_TAG}>`

/** 纯文本版：system_note / compaction 这类以字符串落地的内容 */
export function markUntrustedText(text: string, source: string): { text: string; escaped: boolean } {
  const e = escapeUntrustedText(text)
  return { text: `${untrustedOpenTag(source)}\n${e.text}\n${UNTRUSTED_CLOSE_TAG}`, escaped: e.escaped }
}

/** 片段版：首尾文本片段就地拼接标记，首尾是图片则各插一段文本；空内容给一对空标签 */
export function markUntrusted(parts: readonly ContentPart[], source: string): MarkedContent {
  let escaped = false
  const body: ContentPart[] = parts.map((p) => {
    if (p.type !== "text") return p
    const e = escapeUntrustedText(p.text)
    escaped = escaped || e.escaped
    return { type: "text", text: e.text }
  })
  const open = untrustedOpenTag(source)
  const first = body[0]
  if (first?.type === "text") body[0] = { type: "text", text: `${open}\n${first.text}` }
  else body.unshift({ type: "text", text: open })
  const last = body[body.length - 1]
  if (last?.type === "text" && body.length > (first?.type === "text" ? 0 : 1)) {
    body[body.length - 1] = { type: "text", text: `${last.text}\n${UNTRUSTED_CLOSE_TAG}` }
  } else body.push({ type: "text", text: UNTRUSTED_CLOSE_TAG })
  return { parts: body, escaped }
}

/** 这条事件的内容翻译给模型时要不要包 */
export function needsUntrustedMark(e: Event): boolean {
  return e.trust === "untrusted"
}
