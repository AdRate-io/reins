/**
 * IR → OpenAI Chat Completions 请求体，并为每条事件记落点。
 *
 * 严格按 OpenAI 官方规范（Boss 定），方言只收 DeepSeek 已验证的 `reasoning_content`（见 models.ts ChatDialect）。
 * 角色只有 system / user / assistant / tool 四种，这是全包唯一出现"角色"的地方之一（宪法二）。
 *
 * Chat 线天然有损、矩阵里如实声明：
 * - thinking 没有回放位（无签名、无加密项）——除 DeepSeek 方言外 dropped；
 * - 没有显式缓存断点——什么都不做（厂商自动前缀缓存）；
 * - assistant 的 content 是单个字符串（DeepSeek 只接受 string | null）——同一轮多段正文合并，lossy(merged-text)；
 * - tool 消息没有错误位——isError 以文本前缀表达，lossy；tool 消息只收文本——图片换成占位文本，lossy。
 */
import {
  type ContentPart,
  type Event,
  type LandingRecord,
  type LoweringCapabilities,
  renderToolReference,
  type ToolSpec,
} from "@reinsjs/core"
import {
  DEFERRED_NOTE,
  ESCAPED_NOTE,
  foreignOrigin,
  type IrBlock,
  type IrItem,
  orderLandings,
} from "../ir.js"
import type { FetchModel } from "../models.js"
import { framedSummary, framedSystemNote } from "../notes.js"

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

export interface ChatToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string }

export interface ChatTool {
  type: "function"
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** 发出去的请求体本体。宿主的 requestOptions 先铺、我们的字段后盖：messages / tools / model / stream 不可被覆盖 */
export interface ChatRequestBody extends Record<string, unknown> {
  model: string
  messages: ChatMessage[]
  tools?: ChatTool[]
  stream: true
  stream_options: { include_usage: true }
}

export interface ChatEncodeInput {
  ir: readonly IrItem[]
  events: readonly Event[]
  model: FetchModel
  capabilities: LoweringCapabilities
  tools?: readonly ToolSpec[]
  systemPrompt?: string
  requestOptions?: Record<string, unknown>
}

const IMAGE_OMITTED = "[image omitted: this model does not accept images]"
const TOOL_IMAGE_OMITTED = "[image omitted: tool messages carry text only]"
const ERROR_PREFIX = "[tool error]\n"

function land(
  out: LandingRecord[],
  e: Event,
  kind: LandingRecord["kind"],
  landing: string,
  ...notes: (string | undefined)[]
) {
  const note = notes.filter((n): n is string => Boolean(n)).join("；")
  out.push(
    note
      ? { eventId: e.id, type: e.type, kind, landing, note }
      : { eventId: e.id, type: e.type, kind, landing },
  )
}

/** 用户内容：只有一段文本就用字符串（最兼容），否则用 content parts；图片走 data: URL */
function userContent(
  parts: readonly ContentPart[],
  images: boolean,
): { content: string | ChatContentPart[]; imagesDropped: boolean } {
  let imagesDropped = false
  const out: ChatContentPart[] = parts.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text }
    if (p.type === "tool_reference") return { type: "text", text: renderToolReference(p) }
    if (!images) {
      imagesDropped = true
      return { type: "text", text: IMAGE_OMITTED }
    }
    return { type: "image_url", image_url: { url: `data:${p.mime};base64,${p.data}` } }
  })
  if (out.length === 1 && out[0]?.type === "text") return { content: out[0].text, imagesDropped }
  return { content: out, imagesDropped }
}

/** tool 消息只收文本：文本段以换行拼接，图片换占位 */
function toolContent(parts: readonly ContentPart[]): { text: string; imagesDropped: boolean } {
  let imagesDropped = false
  const text = parts
    .map((p) => {
      if (p.type === "text") return p.text
      if (p.type === "tool_reference") return renderToolReference(p)
      imagesDropped = true
      return TOOL_IMAGE_OMITTED
    })
    .join("\n")
  return { text, imagesDropped }
}

/** tool_call 入参回到线上是 JSON 字符串；读侧解析失败时存的是原始字符串，写侧原样送回 */
function argumentsOf(args: unknown): string {
  return typeof args === "string" ? args : JSON.stringify(args ?? {})
}

export function encodeChatRequest(input: ChatEncodeInput): {
  body: ChatRequestBody
  landings: LandingRecord[]
} {
  const { model, capabilities } = input
  const target = { provider: model.provider, api: model.api, model: model.id }
  const reasoningContent = model.chat?.reasoningContent === true
  const messages: ChatMessage[] = []
  const landings: LandingRecord[] = []

  if (input.systemPrompt) messages.push({ role: "system", content: input.systemPrompt })

  for (const item of input.ir) {
    switch (item.kind) {
      case "user": {
        const c = userContent(item.parts, capabilities.images)
        messages.push({ role: "user", content: c.content })
        const lossy = item.deferred || item.escaped || c.imagesDropped
        land(
          landings,
          item.event,
          lossy ? "lossy" : "exact",
          "user",
          item.deferred
            ? `the user message sits between a tool call and its results; ${DEFERRED_NOTE}`
            : undefined,
          item.escaped ? ESCAPED_NOTE : undefined,
          c.imagesDropped
            ? "the model takes no images, so they are replaced with placeholder text"
            : undefined,
        )
        break
      }
      case "assistant": {
        messages.push(assistantMessage(item.blocks, item.origin, target, reasoningContent, landings))
        break
      }
      case "tool_result": {
        const c = toolContent(item.parts)
        messages.push({
          role: "tool",
          tool_call_id: item.toolCallId,
          content: item.isError ? ERROR_PREFIX + c.text : c.text,
        })
        const lossy = item.escaped || item.isError || c.imagesDropped
        land(
          landings,
          item.event,
          lossy ? "lossy" : "exact",
          c.imagesDropped ? "tool-text-only" : "tool",
          item.isError
            ? "a Chat tool message has no error flag, so isError is expressed with a [tool error] prefix"
            : undefined,
          c.imagesDropped
            ? "a tool message takes text only, so images are replaced with placeholder text"
            : undefined,
          item.escaped ? ESCAPED_NOTE : undefined,
        )
        break
      }
      case "system_note": {
        if (capabilities.midConversationSystem) {
          messages.push({ role: "system", content: item.text })
          land(
            landings,
            item.event,
            item.escaped ? "lossy" : "exact",
            "system",
            item.escaped ? ESCAPED_NOTE : undefined,
            item.deferred ? DEFERRED_NOTE : undefined,
          )
        } else {
          messages.push({ role: "user", content: framedSystemNote(item.noteKind, item.text) })
          land(
            landings,
            item.event,
            "lossy",
            "user-role",
            "the upstream does not accept mid-conversation system, so it is wrapped in a <system_note> tag and sent with the user role",
            item.escaped ? ESCAPED_NOTE : undefined,
            item.deferred ? DEFERRED_NOTE : undefined,
          )
        }
        break
      }
      case "compaction": {
        messages.push({ role: "user", content: framedSummary(item.text) })
        land(
          landings,
          item.event,
          "lossy",
          "user-text",
          "the summary is rendered as user-role text",
          item.escaped ? ESCAPED_NOTE : undefined,
          item.deferred ? DEFERRED_NOTE : undefined,
        )
        break
      }
      case "dropped":
        land(landings, item.event, "dropped", "none", item.note)
        break
    }
  }

  // 宿主选项里的 tools 不透传：工具表只由 input.tools 决定，没有时也不能让宿主塞一份进来
  const { tools: _tools, ...passthrough } = input.requestOptions ?? {}
  // Chat 没有"声明但不载入"的落点：deferLoading 的工具不发（模型看不见也调不了，与过滤同义；L1）
  const shownTools = (input.tools ?? []).filter((t) => t.deferLoading !== true)
  const body: ChatRequestBody = {
    ...passthrough,
    model: model.id,
    messages,
    ...(shownTools.length > 0
      ? {
          tools: shownTools.map(
            (t): ChatTool => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            }),
          ),
        }
      : {}),
    stream: true,
    stream_options: { include_usage: true },
  }
  return { body, landings: orderLandings(input.events, landings) }
}

/**
 * 一轮模型输出 → 一条 assistant 消息。
 * - 正文：Chat 的 assistant.content 是单个字符串，多段以空行合并，每段记 lossy(merged-text)；
 * - thinking：开了 reasoning_content 方言且来源同家 → 回填（多段以换行拼接），否则 dropped；
 *   方言开着时**字段必须在**（DeepSeek 带 tools 的请求缺它 400），没有可回填的就给空串；
 * - tool_call：`arguments` 是 JSON 字符串。
 */
function assistantMessage(
  blocks: readonly IrBlock[],
  origin: { provider: string; api: string; model: string },
  target: { provider: string; api: string; model: string },
  reasoningContent: boolean,
  landings: LandingRecord[],
): ChatMessage {
  const texts = blocks.filter((b): b is Extract<IrBlock, { type: "text" }> => b.type === "text")
  const thinkings = blocks.filter((b): b is Extract<IrBlock, { type: "thinking" }> => b.type === "thinking")
  const calls = blocks.filter((b): b is Extract<IrBlock, { type: "tool_call" }> => b.type === "tool_call")
  const foreign = foreignOrigin(origin, target)

  for (const t of texts) {
    if (texts.length > 1)
      land(
        landings,
        t.event,
        "lossy",
        "merged-text",
        "multiple text segments of one turn are merged into a single string",
      )
    else land(landings, t.event, "exact", "assistant-content")
  }
  const replayable = reasoningContent && !foreign
  for (const t of thinkings) {
    if (replayable) land(landings, t.event, "exact", "reasoning_content")
    else if (reasoningContent)
      land(
        landings,
        t.event,
        "dropped",
        "none",
        `thinking from ${origin.provider}/${origin.api} is not filled back in for a model of another family`,
      )
    else
      land(
        landings,
        t.event,
        "dropped",
        "none",
        "Chat Completions has no landing for replaying thinking (no signature, no encrypted item)",
      )
  }
  for (const c of calls) land(landings, c.event, "exact", "tool_calls")

  const msg: ChatMessage = {
    role: "assistant",
    content: texts.length > 0 ? texts.map((t) => t.text).join("\n\n") : null,
  }
  if (calls.length > 0) {
    msg.tool_calls = calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: argumentsOf(c.args) },
    }))
  }
  if (reasoningContent) msg.reasoning_content = replayable ? thinkings.map((t) => t.text).join("\n") : ""
  return msg
}
