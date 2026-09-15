/**
 * 内容片段在 reins 与 TanStack AI 之间的互译。
 *
 * reins 只有两种片段：text（`text` 字段）与 image（base64 `data` + `mime`）；TanStack 的 TextPart 用 `content`，
 * 多媒体片段统一是 `{ source: { type: "data" | "url", value, mimeType } }`。能一一对应的逐字翻译，
 * 对不上的（音频、视频、文档、URL 图片）以占位文本代替并在返回值里声明丢了什么（P7：有损必声明）。
 */
import { type ContentPart as ReinsPart, renderToolReference } from "@reinsjs/core"
import type { ContentPart as TanstackPart } from "@tanstack/ai"

export interface ImportedContent {
  parts: ReinsPart[]
  /** 无法翻译、只留下占位的片段说明 */
  dropped: string[]
}

/** reins → TanStack：给 TanStack 工具结果与消息用 */
export function toTanstackParts(parts: readonly ReinsPart[]): TanstackPart[] {
  return parts.map((p): TanstackPart => {
    if (p.type === "text") return { type: "text", content: p.text }
    // 工具定义引用（L1）：TanStack 没有对应片段，展开成文本
    if (p.type === "tool_reference") return { type: "text", content: renderToolReference(p) }
    return { type: "image", source: { type: "data", value: p.data, mimeType: p.mime } }
  })
}

/**
 * reins → TanStack 的消息正文：全是文本时给单个字符串（多段以空行连接，这是 TanStack 消息的自然形态），
 * 含图片时给片段数组。
 */
export function toTanstackContent(parts: readonly ReinsPart[]): string | TanstackPart[] {
  if (parts.every((p) => p.type !== "image"))
    return parts
      .map((p) => (p.type === "text" ? p.text : p.type === "tool_reference" ? renderToolReference(p) : ""))
      .join("\n\n")
  return toTanstackParts(parts)
}

/** TanStack → reins：导入客户端发来的消息与 TanStack 记录的工具结果 */
export function fromTanstackContent(
  content: string | null | readonly TanstackPart[] | undefined,
): ImportedContent {
  if (content === null || content === undefined) return { parts: [], dropped: [] }
  if (typeof content === "string") return { parts: [{ type: "text", text: content }], dropped: [] }
  const parts: ReinsPart[] = []
  const dropped: string[] = []
  for (const p of content) {
    if (p.type === "text") {
      parts.push({ type: "text", text: p.content })
      continue
    }
    if (p.type === "image" && p.source.type === "data") {
      parts.push({ type: "image", mime: p.source.mimeType, data: p.source.value })
      continue
    }
    const what = p.type === "image" ? "image(url)" : p.type
    dropped.push(what)
    parts.push({ type: "text", text: `[${what} part could not be imported into the reins timeline]` })
  }
  return { parts, dropped }
}

/**
 * TanStack 工具执行结果（任意值）→ reins 内容片段。TanStack 已把字符串结果尝试 JSON.parse 过，
 * 所以这里拿到的多半是对象；能认出 ContentPart[] 的按片段翻译，其余 JSON 化成文本。
 */
export function fromTanstackToolResult(result: unknown): ReinsPart[] {
  if (typeof result === "string") return [{ type: "text", text: result }]
  if (result === undefined || result === null) return [{ type: "text", text: "" }]
  if (Array.isArray(result) && result.length > 0 && result.every(isTanstackPart))
    return fromTanstackContent(result as TanstackPart[]).parts
  const json = JSON.stringify(result)
  return [{ type: "text", text: typeof json === "string" ? json : String(result) }]
}

function isTanstackPart(x: unknown): x is TanstackPart {
  if (typeof x !== "object" || x === null) return false
  const p = x as { type?: unknown; content?: unknown; source?: unknown }
  if (p.type === "text") return typeof p.content === "string"
  return (
    (p.type === "image" || p.type === "audio" || p.type === "video" || p.type === "document") &&
    typeof p.source === "object" &&
    p.source !== null
  )
}
