/**
 * MCP ⇄ reins 的纯函数翻译：工具声明 → `Tool` 的静态部分，`tools/call` 结果 → `ContentPart[]`。
 * 不碰网络、不碰事件，单测直接喂 JSON。
 *
 * 有损的地方都在这里明说（P7）：reins 的 ContentPart 只有文本与图片，MCP 的 audio / 二进制 resource
 * 翻成一行说明文字告诉模型"有这么个东西但看不到"，不静默丢。
 */
import type { ContentPart, Tool } from "@reinsjs/core"
import type { McpToolAnnotations, McpToolInfo } from "./types.js"

/** Anthropic / OpenAI 对工具名的共同要求；MCP 没有这个限制，不合规的名字要改写，否则请求 400 */
export const MODEL_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

/** 给模型看的名字：加前缀、把不合规字符换成 `_`、截到 64。返回值与原名不同则调用方应告警一次 */
export function modelToolName(mcpName: string, prefix = ""): string {
  const raw = `${prefix}${mcpName}`
  if (MODEL_TOOL_NAME_RE.test(raw)) return raw
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)
  return cleaned.length > 0 ? cleaned : "_"
}

/**
 * 注解 → 风险档。spec 说注解只是提示、不可信服务器的注解不能当权限依据，所以这里只定**缺省值**：
 * 明说只读 → low；明说破坏性 → high（并缺省要审批）；其余（含完全没注解）→ medium，交给 approval 模块的策略。
 * 注意 spec 里 destructiveHint 缺省为 true，我们刻意不把"没写"当"破坏性"——否则每个 MCP 工具都要审批，
 * 宿主要那么严可以用 `override` 自己定。
 */
export function riskOf(annotations: McpToolAnnotations | undefined): NonNullable<Tool["risk"]> {
  if (annotations?.destructiveHint === true) return "high"
  if (annotations?.readOnlyHint === true) return "low"
  return "medium"
}

/** `tools/list` 里的一项 → 纯数据 McpToolInfo；形状不对就抛（服务器声明不合法，宁可起步失败） */
export function toToolInfo(raw: unknown): McpToolInfo {
  if (typeof raw !== "object" || raw === null) throw new TypeError("MCP 工具声明不是对象")
  const t = raw as Record<string, unknown>
  if (typeof t.name !== "string" || t.name.length === 0) throw new TypeError("MCP 工具声明缺少 name")
  if (typeof t.inputSchema !== "object" || t.inputSchema === null)
    throw new TypeError(`MCP 工具 ${t.name} 缺少 inputSchema`)
  const info: McpToolInfo = { name: t.name, inputSchema: t.inputSchema as Record<string, unknown> }
  if (typeof t.title === "string") info.title = t.title
  if (typeof t.description === "string") info.description = t.description
  if (typeof t.outputSchema === "object" && t.outputSchema !== null)
    info.outputSchema = t.outputSchema as Record<string, unknown>
  if (typeof t.annotations === "object" && t.annotations !== null)
    info.annotations = t.annotations as McpToolAnnotations
  return info
}

/** base64 文本对应的字节数（去掉填充） */
function base64Bytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

/** `tools/call` 结果的形状（只取我们用到的字段；SDK 类型不出本包） */
export interface McpCallResult {
  content?: unknown
  structuredContent?: unknown
  isError?: unknown
}

/**
 * MCP 内容块 → reins 内容片段。
 * - text → 文本；image → 图片（mime + base64）
 * - audio → 一行说明（模型看不到音频）
 * - resource_link → 一行 "Resource link: uri (name) [mime]"
 * - resource（内嵌）：文本资源 → 带 uri 头的文本；图片二进制 → 图片；其他二进制 → 一行说明
 * - 不认识的块 → JSON 文本（不静默丢）
 * - content 为空而有 structuredContent → 其 JSON；都没有 → 空文本（模型总得有个结果块）
 */
export function toContentParts(result: McpCallResult): ContentPart[] {
  const blocks = Array.isArray(result.content) ? result.content : []
  const parts: ContentPart[] = []
  for (const raw of blocks) {
    const b = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
    switch (b.type) {
      case "text":
        parts.push({ type: "text", text: typeof b.text === "string" ? b.text : "" })
        break
      case "image":
        if (typeof b.data === "string" && typeof b.mimeType === "string")
          parts.push({ type: "image", mime: b.mimeType, data: b.data })
        else parts.push({ type: "text", text: "[image block without data/mimeType]" })
        break
      case "audio": {
        const bytes = typeof b.data === "string" ? base64Bytes(b.data) : 0
        parts.push({
          type: "text",
          text: `[audio ${String(b.mimeType ?? "unknown type")}, ${bytes} bytes; audio cannot be shown to the model]`,
        })
        break
      }
      case "resource_link": {
        const name = typeof b.name === "string" ? ` (${b.name})` : ""
        const mime = typeof b.mimeType === "string" ? ` [${b.mimeType}]` : ""
        const desc = typeof b.description === "string" ? ` — ${b.description}` : ""
        parts.push({ type: "text", text: `Resource link: ${String(b.uri)}${name}${mime}${desc}` })
        break
      }
      case "resource": {
        const r = (typeof b.resource === "object" && b.resource !== null ? b.resource : {}) as Record<
          string,
          unknown
        >
        const uri = String(r.uri ?? "")
        const mime = typeof r.mimeType === "string" ? r.mimeType : undefined
        if (typeof r.text === "string") {
          parts.push({ type: "text", text: `[resource ${uri}${mime ? ` (${mime})` : ""}]\n${r.text}` })
        } else if (typeof r.blob === "string" && mime?.startsWith("image/")) {
          parts.push({ type: "image", mime, data: r.blob })
        } else {
          const bytes = typeof r.blob === "string" ? base64Bytes(r.blob) : 0
          parts.push({
            type: "text",
            text: `[binary resource ${uri}${mime ? ` (${mime})` : ""}, ${bytes} bytes; not shown to the model]`,
          })
        }
        break
      }
      default:
        parts.push({ type: "text", text: JSON.stringify(raw) ?? String(raw) })
    }
  }
  if (parts.length === 0) {
    if (result.structuredContent !== undefined && result.structuredContent !== null)
      parts.push({ type: "text", text: JSON.stringify(result.structuredContent) ?? "" })
    else parts.push({ type: "text", text: "" })
  }
  return parts
}
