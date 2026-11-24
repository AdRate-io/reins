/**
 * 工具相关的纯函数：给模型看的声明、执行结果归一化。与循环解耦，便于适配器（TanStack / pi）复用。
 */
import type { ContentPart, Trust } from "../events/base.js"
import type { ToolSpec } from "../lowering/types.js"
import { isImageRef } from "./media-refs.js"
import type { Tool, ToolResult } from "./types.js"

/**
 * 工具结果事件该带的 trust（§14）：工具声明了 `resultTrust` 且结果不是错误 → 按声明；否则 undefined（事件工厂按 actor 缺省，即 untrusted）。
 * 这是唯一的判定点——循环的两条路（execute 结果、宿主回填的客户端工具结果）与 TanStack 适配器的两条路都调它，
 * "同一个判定写两处必须同一个纯函数"（踩坑记录 #3 / #20 / #40 的教训）。
 */
export function toolResultTrust(tool: Tool | undefined, isError: boolean): Trust | undefined {
  if (!tool || tool.resultTrust === undefined || isError) return undefined
  return tool.resultTrust
}

/**
 * 客户端工具：本循环不执行，等宿主回填 tool_result（真源索引）。没有 execute 或声明 `side: "client"` 的都算。
 * 循环执行工具批与暂停时算 `awaiting` 共用这一个判定
 */
export function isClientTool(tool: Tool): boolean {
  return !tool.execute || tool.side === "client"
}

/**
 * 定义一个带入参类型的工具并擦成 Tool：对象字面量里 execute / validate / needsApproval 的 input 都按 TInput 推断，
 * 返回值却能直接放进 Tool[]。不用它也行，只是 needsApproval 写成函数时 TS 会因参数逆变拒绝放进数组。
 */
export function defineTool<TInput>(tool: Tool<TInput>): Tool {
  return tool as Tool
}

/** 工具声明的模型可见部分（刻意单参：常被 `tools.map(toolSpecOf)` 调用，多一个参数就会吃进下标） */
export function toolSpecOf(tool: Tool): ToolSpec {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
}

/** 带"声明但不载入"标记的规格（L1）：runLoop 按 BeforeModelPatch.deferredTools 对本轮工具表逐件调 */
export function deferredToolSpecOf(tool: Tool, deferred: boolean): ToolSpec {
  return deferred ? { ...toolSpecOf(tool), deferLoading: true } : toolSpecOf(tool)
}

/** 时长：缺省，或有限正数 */
function isDuration(x: unknown): boolean {
  return x === undefined || (typeof x === "number" && Number.isFinite(x) && x > 0)
}

/**
 * 图片片段可写进日志的 mime 白名单（真源索引）：Anthropic / OpenAI / Gemini 都收的四种，逐字比对、不做大小写或别名归一。
 * 不在表里的（svg、heic、`image/jpg` 写法、非图片类型）一旦以图片片段进日志，之后每次请求都整段回放、厂商回非瞬断 400，
 * 会话卡死（全库审查 2026-11-25 #9）。片段形状（`isContentPart`）调这一份；server、tools-mcp、降级层第二波改调（BUG-261125-1），在那之前那几处仍只查字符串
 */
export const SUPPORTED_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

/** mime 是否在图片白名单里（`SUPPORTED_IMAGE_MIMES`）；非字符串一律 false */
export function isSupportedImageMime(mime: unknown): boolean {
  return typeof mime === "string" && SUPPORTED_IMAGE_MIMES.has(mime)
}

/**
 * 内容片段的形状校验，全包唯一一份（真源索引）：工具返回值归一（本文件）与 runLoop 输入草稿 / 片段数组（run-loop.ts）都调它。
 * 坏片段一旦进日志，之后每次读到它都会崩（会话报废），所以在写之前拦。
 * 规则：text 有 `text`；image 是内联（`mime` 与 `data`）或引用（`isImageRef`：blobId 非空且 ≤ 128 字符），`data` 与 `blobId`
 * 恰好一个，两种形态的 mime 都必须在白名单里（`isSupportedImageMime`）；video / audio 的 mime 以 "video/" / "audio/" 开头、
 * `durationSec` 缺省或为有限正数；tool_reference 有名字、描述与对象形 inputSchema。
 * 宿主经 HTTP 送来的用户消息另有白名单（server `rebuildContentParts`，两份实现靠跨包用例锁同口径），不含引用段
 */
export function isContentPart(x: unknown): x is ContentPart {
  if (typeof x !== "object" || x === null) return false
  const p = x as Record<string, unknown>
  switch (p.type) {
    case "text":
      return typeof p.text === "string"
    case "image":
      // mime 白名单 fail-closed：厂商不收的类型进了日志，之后每轮整段回放都 400、会话卡死。引用形态另要 isImageRef 的形状——
      // 它只查 image/ 前缀（降级层靠它认出日志里已有的旧引用，不能跟着收紧），白名单在这里叠加
      if (!isSupportedImageMime(p.mime)) return false
      if (p.blobId !== undefined) return isImageRef(p)
      return typeof p.data === "string"
    case "video":
    case "audio":
      return (
        typeof p.mime === "string" &&
        p.mime.startsWith(`${p.type}/`) &&
        typeof p.data === "string" &&
        isDuration(p.durationSec)
      )
    case "tool_reference":
      return (
        typeof p.name === "string" &&
        typeof p.description === "string" &&
        typeof p.inputSchema === "object" &&
        p.inputSchema !== null &&
        !Array.isArray(p.inputSchema)
      )
    default:
      return false
  }
}

/**
 * 工具结果里只有 mime 不在白名单、其余形状都对的图片片段（内联 `data` 或引用 `blobId` 是字符串）换成的说明（模型可见）。
 * 例：图表类 MCP 返回 svg。整条结果 JSON 化会把 base64 原样当文本塞进上下文，这里只换掉那一段，其余片段照旧
 */
export function unsupportedImageText(mime: string): string {
  return `[image omitted: ${mime} is not a supported image type; supported types are ${[...SUPPORTED_IMAGE_MIMES].join(", ")}]`
}

/** 形状对、只是 mime 不在白名单的图片片段（mime 是字符串，`data` 或 `blobId` 恰好一个是字符串） */
function isUnsupportedImagePart(x: unknown): x is { type: "image"; mime: string } {
  if (typeof x !== "object" || x === null) return false
  const p = x as { type?: unknown; mime?: unknown; data?: unknown; blobId?: unknown }
  return (
    p.type === "image" &&
    typeof p.mime === "string" &&
    !isSupportedImageMime(p.mime) &&
    (typeof p.data === "string") !== (typeof p.blobId === "string")
  )
}

/**
 * 片段数组里白名单外的图片逐段换成说明；还有别的坏片段就返回 undefined（交给 JSON 化兜底）。
 * 一段都没换时原数组原样返回（引用不变，便于调用方判断）
 */
function withUnsupportedImagesReplaced(parts: readonly unknown[]): ContentPart[] | undefined {
  let replaced = false
  const out: ContentPart[] = []
  for (const p of parts) {
    if (isContentPart(p)) out.push(p)
    else if (isUnsupportedImagePart(p)) {
      replaced = true
      out.push({ type: "text", text: unsupportedImageText(p.mime) })
    } else return undefined
  }
  return replaced ? out : (parts as ContentPart[])
}

/**
 * execute 的返回值 → 模型看到的内容。规则按直觉：
 * - string → 一段文本
 * - ContentPart[] → 原样
 * - { content, isError? } → 原样（唯一能表达"这是错误"的形态）
 * - 上两种里只有白名单外的图片（svg 等）不合规 → 只把那几段换成说明（`unsupportedImageText`），其余照旧
 * - undefined / null → 空文本（工具没话说也得给模型一个结果块）
 * - 其余 → JSON 文本
 */
export function normalizeToolOutput(output: unknown): ToolResult {
  if (typeof output === "string") return { content: [{ type: "text", text: output }] }
  if (output === undefined || output === null) return { content: [{ type: "text", text: "" }] }
  if (Array.isArray(output)) {
    const content = withUnsupportedImagesReplaced(output)
    if (content) return { content }
  } else if (typeof output === "object") {
    const r = output as { content?: unknown; isError?: unknown }
    if (Array.isArray(r.content) && (r.isError === undefined || typeof r.isError === "boolean")) {
      const content = withUnsupportedImagesReplaced(r.content)
      if (content)
        return content === r.content ? (output as ToolResult) : { ...(output as ToolResult), content }
    }
  }
  const json = JSON.stringify(output)
  return { content: [{ type: "text", text: typeof json === "string" ? json : String(output) }] }
}

export function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === "string" ? err : (JSON.stringify(err) ?? String(err))
}
