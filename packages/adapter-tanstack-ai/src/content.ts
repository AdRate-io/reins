/**
 * 内容片段在 reins 与 TanStack AI 之间的互译。
 *
 * reins 的片段：text（`text` 字段）、image / video / audio（base64 `data` + `mime`，视频音频可带 `durationSec`）、
 * tool_reference；TanStack 的 TextPart 用 `content`，多媒体片段统一是 `{ source: { type: "data" | "url", value, mimeType } }`。
 * 能一一对应的逐字翻译（data 源的图片 / 视频 / 音频，2026-11-05 起视频音频双向互译；TanStack 没有时长字段，导出丢
 * `durationSec`、导入没有时长，估算走字节折算）；对不上的（文档、URL 源、mime 前缀与类型不符）以占位文本代替并在返回值里
 * 声明丢了什么（P7：有损必声明）。
 */
import { isContentPart, type ContentPart as ReinsPart, renderToolReference } from "@reinsjs/core"
import type { ContentPart as TanstackPart } from "@tanstack/ai"

export interface ImportedContent {
  parts: ReinsPart[]
  /** 无法翻译、只留下占位的片段说明 */
  dropped: string[]
}

/** reins → TanStack：给 TanStack 工具结果与消息用 */
export function toTanstackParts(parts: readonly ReinsPart[]): TanstackPart[] {
  return parts.map((p): TanstackPart => {
    switch (p.type) {
      case "text":
        return { type: "text", content: p.text }
      // 工具定义引用（L1）：TanStack 没有对应片段，展开成文本
      case "tool_reference":
        return { type: "text", content: renderToolReference(p) }
      case "image":
      case "video":
      case "audio":
        // durationSec 只用于 reins 的估算，模型看不到；TanStack 没有对应字段，不带
        return { type: p.type, source: { type: "data", value: p.data, mimeType: p.mime } }
      default: {
        const _exhaustive: never = p
        return _exhaustive
      }
    }
  })
}

/** 片段在纯文本语境里的写法（TanStack 消息的文本形态、模型看不到的展示）：媒体写 `[<类型> <mime>]` */
export function partAsText(p: ReinsPart): string {
  switch (p.type) {
    case "text":
      return p.text
    case "tool_reference":
      return renderToolReference(p)
    case "image":
    case "video":
    case "audio":
      return `[${p.type} ${p.mime}]`
    default: {
      const _exhaustive: never = p
      return _exhaustive
    }
  }
}

/**
 * reins → TanStack 的消息正文：只有文本 / 工具引用时给单个字符串（多段以空行连接，这是 TanStack 消息的自然形态），
 * 含任何媒体（图片 / 视频 / 音频）时给片段数组。
 */
export function toTanstackContent(parts: readonly ReinsPart[]): string | TanstackPart[] {
  if (parts.every((p) => p.type === "text" || p.type === "tool_reference"))
    return parts.map(partAsText).join("\n\n")
  return toTanstackParts(parts)
}

/**
 * 单个 TanStack 片段 → reins 片段；翻不动返回 undefined。
 * 客户端数据只有静态类型、运行时什么都可能来（缺 mimeType、value 不是字符串），而导入的草稿直接 append、
 * 不经 runLoop 的白名单——所以造出来的片段必须过 core `isContentPart`（片段形状唯一真源），坏片段一旦进日志整条会话报废
 */
function importPart(p: TanstackPart): ReinsPart | undefined {
  const raw = p as {
    type?: unknown
    content?: unknown
    source?: { type?: unknown; value?: unknown; mimeType?: unknown }
  }
  let candidate: unknown
  if (raw.type === "text") candidate = { type: "text", text: raw.content }
  else if (
    (raw.type === "image" || raw.type === "video" || raw.type === "audio") &&
    raw.source?.type === "data"
  )
    candidate = { type: raw.type, mime: raw.source.mimeType, data: raw.source.value }
  return isContentPart(candidate) ? candidate : undefined
}

/** 翻不动的片段在 `dropped` 里的写法：媒体带来源（`video(url)`）或 mime（`audio(application/octet-stream)`），读不出就只写类型 */
function droppedLabel(p: TanstackPart): string {
  const raw = p as { type?: unknown; source?: { type?: unknown; mimeType?: unknown } }
  const type = typeof raw.type === "string" ? raw.type : "unknown"
  if (type !== "image" && type !== "video" && type !== "audio") return type
  if (raw.source?.type === "url") return `${type}(url)`
  return typeof raw.source?.mimeType === "string" ? `${type}(${raw.source.mimeType})` : type
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
    const part = importPart(p)
    if (part) {
      parts.push(part)
      continue
    }
    const what = droppedLabel(p)
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
