/**
 * IR → Anthropic Messages 请求体，并为每条事件记落点。
 *
 * 与 Chat 线相比 Anthropic 规矩最多，这里逐条落实（规则原文 F0 实测，spikes/cf-gateway-fidelity）：
 * - **tool_result 紧跟**：同批 tool_result 必须在 tool_use 所在 assistant 的下一条 user 里；后移由 IR 完成，这里只把连续的
 *   user 侧内容（tool_result、用户消息、摘要）并进同一条 user（F0 A5b 实测同条 user 里 tool_result 后接文本可达）；
 * - **中途 system 摆放**（S1）：不能是首条、必须紧跟 user（含只带 tool_result 的 user）、后接 assistant 或收尾。所以说明
 *   一律攒到"下一条 assistant 之前"或末尾再放出；此刻前一条不是 user（是 assistant 或什么都没有）就退成 `<system_note>`
 *   框住的 user 文本，记 lossy(user-role)。放出位置比时间线晚了一条 user 的，仍算 exact（说明只换位置，见 CLAUDE.md）；
 * - **thinking 回放**：带 signature 原样回放（F0 A7b 接受、伪造签名 400）；无签名（流中断）与来自别家的一律 dropped 声明——
 *   不像 pi-ai 那样降成正文，模型的私下推理不该以它"说过的话"出现在历史里；`redacted_thinking` 用 data 原样回放；
 * - **缓存断点**：最多 4 个。我们打三处——system 末块、tools 末项、最后一条 user 末块（厂商按前缀向前找命中，20 块回看窗口）；
 *   说明殿后（末条是 system）时按 `midSystemCacheBreakpoint` 处置，缺省顶层 `cache_control`（B1 实测与不注入持平）；
 * - `max_tokens` 必填：宿主 requestOptions 没给就用模型声明的 maxOutputTokens；`thinking` 不缺省设置——Opus 5 起厂商缺省
 *   就是 adaptive，是否开、开多深由宿主按模型代次决定（Fable 5.1 对 `type:"disabled"` 400）；
 * - **延迟加载**（L1，spikes/l1-deferred-tools 实测）：`ToolSpec.deferLoading` → `defer_loading: true`，工具留在 tools 块里、
 *   表整段不变；结果里的 `tool_reference` 段 → `tool_reference` 块由厂商就地展开。厂商规矩：tool_result 内引用不能与文本混放
 *   （文本段改放同条 user 里紧随的 text 块，记 lossy）；引用指向 tools 里没有的名字 400（整段历史都校验，所以未绑定的引用一律
 *   展开成文本）；全部工具 defer_loading 400（此时不延迟）；defer_loading 工具不能带 cache_control（断点打在最后一个非延迟工具上）。
 *   能力位关着（第三方上游）时 deferLoading 的工具不发、引用段展开成文本。
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
  type ModelOrigin,
  orderLandings,
} from "../ir.js"
import type { FetchModel } from "../models.js"
import { framedSummary, framedSystemNote } from "../notes.js"

export interface AnthropicCacheControl {
  type: "ephemeral"
  ttl?: "5m" | "1h"
}

export type AnthropicUserBlock =
  | { type: "text"; text: string; cache_control?: AnthropicCacheControl }
  | {
      type: "image"
      source: { type: "base64"; media_type: string; data: string }
      cache_control?: AnthropicCacheControl
    }
  | {
      type: "tool_result"
      tool_use_id: string
      content?: AnthropicToolResultBlock[]
      is_error?: true
      cache_control?: AnthropicCacheControl
    }

/** 文本与图片块：user 消息与 tool_result 内容共用的形状 */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }

export type AnthropicToolResultBlock =
  | AnthropicContentBlock
  /** 工具定义引用：厂商就地展开成完整定义，不能与其他块混放（L1） */
  | { type: "tool_reference"; tool_name: string }

export type AnthropicAssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }

export type AnthropicMessage =
  | { role: "user"; content: AnthropicUserBlock[] }
  | { role: "assistant"; content: AnthropicAssistantBlock[] }
  | { role: "system"; content: { type: "text"; text: string }[] }

export interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
  /** 声明但不载入上下文，历史里出现 tool_reference 后才可见；不能与 cache_control 同在（L1） */
  defer_loading?: true
  cache_control?: AnthropicCacheControl
}

/** 发出去的请求体本体。宿主的 requestOptions 先铺、我们的字段后盖：model / messages / system / tools / stream 不可被覆盖 */
export interface AnthropicRequestBody extends Record<string, unknown> {
  model: string
  max_tokens: number
  system?: { type: "text"; text: string; cache_control?: AnthropicCacheControl }[]
  messages: AnthropicMessage[]
  tools?: AnthropicTool[]
  stream: true
  cache_control?: AnthropicCacheControl
}

export interface AnthropicEncodeInput {
  ir: readonly IrItem[]
  events: readonly Event[]
  model: FetchModel
  capabilities: LoweringCapabilities
  tools?: readonly ToolSpec[]
  systemPrompt?: string
  requestOptions?: Record<string, unknown>
}

/** Anthropic 每个请求最多 4 个断点（顶层自动缓存也占一个），超出即 400 */
export const MAX_ANTHROPIC_BREAKPOINTS = 4

const IMAGE_OMITTED = "[image omitted: this model does not accept images]"
const EMPTY_NOTE =
  "the content is empty and Anthropic rejects empty text blocks, so the whole message is not sent"
const MOVED_NOTE =
  "moved to just after the next user message (a system message must follow a user message, and be followed by an assistant message or the end)"
const REF_TEXT_ASIDE_NOTE =
  "the result's text segments move to a text block after this batch of tool_result in the same user message (a reference inside a tool_result cannot be mixed with text, and tool_result must come first in a user message)"
const REF_UNTRUSTED_NOTE =
  "a tool reference in an untrusted result does not take the native landing (untrusted content must not light up tools for the model), so it is expanded into text"
const REF_UNBOUND_NOTE =
  "the referenced tool is absent from this request's tool table (the provider validates references across the whole history and answers 400 if one is missing), so the definition is expanded into text"

function land(
  out: LandingRecord[],
  e: Event,
  kind: LandingRecord["kind"],
  landing: string,
  ...notes: (string | undefined)[]
) {
  const note = notes.filter((n): n is string => Boolean(n)).join("; ")
  out.push(
    note
      ? { eventId: e.id, type: e.type, kind, landing, note }
      : { eventId: e.id, type: e.type, kind, landing },
  )
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** 内容段 → Anthropic 块；空文本段跳过（厂商不接受空文本块），图片按模型能力处置，工具引用展开成文本（原生落点在 tool_result 分支另行处理） */
function blocksOf(
  parts: readonly ContentPart[],
  images: boolean,
): { blocks: AnthropicContentBlock[]; imagesDropped: boolean } {
  let imagesDropped = false
  const blocks: AnthropicContentBlock[] = []
  for (const p of parts) {
    if (p.type === "text") {
      if (p.text.length > 0) blocks.push({ type: "text", text: p.text })
    } else if (p.type === "tool_reference") {
      blocks.push({ type: "text", text: renderToolReference(p) })
    } else if (images) {
      blocks.push({ type: "image", source: { type: "base64", media_type: p.mime, data: p.data } })
    } else {
      imagesDropped = true
      blocks.push({ type: "text", text: IMAGE_OMITTED })
    }
  }
  return { blocks, imagesDropped }
}

interface PendingNote {
  item: Extract<IrItem, { kind: "system_note" }>
  /** 放出位置比时间线晚了至少一条 user 侧内容 */
  moved: boolean
}

export function encodeAnthropicRequest(input: AnthropicEncodeInput): {
  body: AnthropicRequestBody
  landings: LandingRecord[]
} {
  const { model, capabilities } = input
  const target: ModelOrigin = { provider: model.provider, api: model.api, model: model.id }
  const dialect = model.anthropic ?? {}
  /** 本次请求工具表里的名字（含 deferLoading 的）：tool_reference 只能指向它们，否则厂商 400 */
  const boundNames = new Set((input.tools ?? []).map((t) => t.name))
  const messages: AnthropicMessage[] = []
  const landings: LandingRecord[] = []
  /** 正在攒的 user 消息（tool_result、用户消息、摘要并进同一条） */
  let userRun: AnthropicUserBlock[] | null = null
  /** 引用结果里的文本段：厂商要求同条 user 里 tool_result 排在最前，所以攒到这批 tool_result 之后再放（L1 spike 形态 D 实测） */
  let asides: AnthropicUserBlock[] = []
  const pendingNotes: PendingNote[] = []

  const openUser = (): AnthropicUserBlock[] => {
    if (!userRun) userRun = []
    // 有说明在等着放出，而这里又来了 user 侧内容：说明的位置就比时间线晚了
    for (const n of pendingNotes) n.moved = true
    return userRun
  }
  const closeUser = () => {
    if (userRun && asides.length > 0) {
      const lastResult = userRun.map((b) => b.type).lastIndexOf("tool_result")
      userRun.splice(lastResult + 1, 0, ...asides)
      asides = []
    }
    if (userRun && userRun.length > 0) messages.push({ role: "user", content: userRun })
    userRun = null
  }
  /** 说明归位：下一条 assistant 之前或末尾。前一条是 user / system 才能放 system，否则退成 user 文本 */
  const flushNotes = () => {
    closeUser()
    if (pendingNotes.length === 0) return
    const last = messages[messages.length - 1]
    if (last && last.role !== "assistant") {
      for (const { item, moved } of pendingNotes) {
        messages.push({ role: "system", content: [{ type: "text", text: item.text }] })
        land(
          landings,
          item.event,
          item.escaped ? "lossy" : "exact",
          "system",
          item.escaped ? ESCAPED_NOTE : undefined,
          item.deferred ? DEFERRED_NOTE : undefined,
          moved ? MOVED_NOTE : undefined,
        )
      }
    } else {
      const why = last
        ? "the previous message is an assistant, and a system message must follow a user message"
        : "a system message cannot come first"
      messages.push({
        role: "user",
        content: pendingNotes.map(({ item }) => ({
          type: "text",
          text: framedSystemNote(item.noteKind, item.text),
        })),
      })
      for (const { item } of pendingNotes) {
        land(
          landings,
          item.event,
          "lossy",
          "user-role",
          `${why}, so it is wrapped in a <system_note> tag and sent with the user role`,
          item.escaped ? ESCAPED_NOTE : undefined,
          item.deferred ? DEFERRED_NOTE : undefined,
        )
      }
    }
    pendingNotes.length = 0
  }

  for (const item of input.ir) {
    switch (item.kind) {
      case "user": {
        const c = blocksOf(item.parts, capabilities.images)
        if (c.blocks.length === 0) {
          land(landings, item.event, "dropped", "none", EMPTY_NOTE)
          break
        }
        openUser().push(...c.blocks)
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
      case "tool_result": {
        const refs = item.parts.filter(
          (p): p is Extract<ContentPart, { type: "tool_reference" }> => p.type === "tool_reference",
        )
        const block: AnthropicUserBlock = { type: "tool_result", tool_use_id: item.toolCallId }
        if (item.isError) block.is_error = true
        // 原生落点只给 system 信任的结果（tool_find / skill_read 这类宿主配置的内容）：untrusted 工具输出不能替模型点亮工具
        const trusted = item.event.trust === "system"
        if (
          refs.length > 0 &&
          capabilities.deferredTools &&
          trusted &&
          refs.every((r) => boundNames.has(r.name))
        ) {
          // 原生落点：tool_result 里只放引用块，厂商就地展开；其余段（说明文字、untrusted 标记）放同条 user 里紧随其后
          block.content = refs.map((r) => ({ type: "tool_reference", tool_name: r.name }))
          const rest = blocksOf(
            item.parts.filter((p) => p.type !== "tool_reference"),
            capabilities.images,
          )
          openUser().push(block)
          asides.push(...rest.blocks)
          const aside = rest.blocks.length > 0
          land(
            landings,
            item.event,
            aside || item.escaped || rest.imagesDropped ? "lossy" : "exact",
            "tool-reference",
            aside ? REF_TEXT_ASIDE_NOTE : undefined,
            rest.imagesDropped
              ? "the model takes no images, so they are replaced with placeholder text"
              : undefined,
            item.escaped ? ESCAPED_NOTE : undefined,
          )
          break
        }
        const c = blocksOf(item.parts, capabilities.images)
        if (c.blocks.length > 0) block.content = c.blocks
        openUser().push(block)
        const unbound = refs.length > 0 && capabilities.deferredTools && trusted
        const untrustedRefs = refs.length > 0 && capabilities.deferredTools && !trusted
        const lossy = item.escaped || c.imagesDropped || unbound
        land(
          landings,
          item.event,
          lossy ? "lossy" : "exact",
          "tool_result",
          unbound ? REF_UNBOUND_NOTE : undefined,
          untrustedRefs ? REF_UNTRUSTED_NOTE : undefined,
          c.imagesDropped
            ? "the model takes no images, so they are replaced with placeholder text"
            : undefined,
          item.escaped ? ESCAPED_NOTE : undefined,
        )
        break
      }
      case "compaction": {
        openUser().push({ type: "text", text: framedSummary(item.text) })
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
      case "system_note": {
        if (capabilities.midConversationSystem) {
          pendingNotes.push({ item, moved: false })
        } else {
          openUser().push({ type: "text", text: framedSystemNote(item.noteKind, item.text) })
          land(
            landings,
            item.event,
            "lossy",
            "user-role",
            "the model does not support mid-conversation system, so it is wrapped in a <system_note> tag and sent with the user role",
            item.escaped ? ESCAPED_NOTE : undefined,
            item.deferred ? DEFERRED_NOTE : undefined,
          )
        }
        break
      }
      case "assistant": {
        const content = assistantBlocks(item.blocks, item.origin, target, landings)
        // 全部块都没法下发（如只有无签名 thinking）时整条不发（空 content 的 assistant 厂商 400），user 侧内容继续并进同一条
        if (content.length === 0) break
        flushNotes()
        messages.push({ role: "assistant", content })
        break
      }
      case "dropped":
        land(landings, item.event, "dropped", "none", item.note)
        break
    }
  }
  flushNotes()

  const ro = input.requestOptions ?? {}
  // 宿主选项里的 system / tools 一律不透传：这两个字段只由事件与工具表决定，没有时也不能让宿主塞一份进来
  const { system: _system, tools: _tools, ...passthrough } = ro
  const body: AnthropicRequestBody = {
    ...passthrough,
    model: model.id,
    max_tokens: typeof ro.max_tokens === "number" ? ro.max_tokens : model.maxOutputTokens,
    messages,
    stream: true,
  }
  if (input.systemPrompt) body.system = [{ type: "text", text: input.systemPrompt }]
  if (input.tools && input.tools.length > 0) {
    const tools = encodeTools(input.tools, capabilities.deferredTools)
    if (tools.length > 0) body.tools = tools
  }
  if (dialect.cacheBreakpoints !== false) placeCacheBreakpoints(body, dialect)
  return { body, landings: orderLandings(input.events, landings) }
}

/**
 * 一轮模型输出 → assistant 的内容块。
 * - 正文：Anthropic 接受多个 text 块，逐段原样（空段跳过并声明）；
 * - thinking：signature 在且来源同家（provider + api）→ thinking 块；redacted → redacted_thinking(data)；
 *   无签名或别家 → dropped。同家不同型号（换代、日期后缀、网关改名）照发并备注，能否读由厂商定（读不了它会丢弃、不计费）；
 * - tool_call：input 必须是对象，不是对象的包成 { value }（lossy wrapped-args）。
 */
function assistantBlocks(
  blocks: readonly IrBlock[],
  origin: ModelOrigin,
  target: ModelOrigin,
  landings: LandingRecord[],
): AnthropicAssistantBlock[] {
  const out: AnthropicAssistantBlock[] = []
  const foreign = foreignOrigin(origin, target)
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        if (b.text.length === 0) {
          land(landings, b.event, "dropped", "none", EMPTY_NOTE)
          break
        }
        out.push({ type: "text", text: b.text })
        land(landings, b.event, "exact", "assistant-text")
        break
      case "thinking": {
        const signature = typeof b.replay.thinkingSignature === "string" ? b.replay.thinkingSignature : ""
        if (foreign) {
          land(
            landings,
            b.event,
            "dropped",
            "none",
            `thinking from ${origin.provider}/${origin.api} has no signature of its own, so it is not replayed`,
          )
          break
        }
        if (signature.length === 0) {
          land(
            landings,
            b.event,
            "dropped",
            "none",
            "thinking with no signature (a broken stream) is rejected by the provider, so it is not replayed",
          )
          break
        }
        const modelNote =
          origin.model !== target.model
            ? `the signature comes from ${origin.model}, but this request targets ${target.model}`
            : undefined
        if (b.replay.redacted === true) {
          out.push({ type: "redacted_thinking", data: signature })
          land(
            landings,
            b.event,
            "exact",
            "redacted-thinking",
            "redacted_thinking is replayed verbatim through its data",
            modelNote,
          )
        } else {
          out.push({ type: "thinking", thinking: b.text, signature })
          land(landings, b.event, "exact", "thinking-block", modelNote)
        }
        break
      }
      case "tool_call": {
        const wrapped = !isPlainObject(b.args)
        out.push({
          type: "tool_use",
          id: b.id,
          name: b.name,
          input: wrapped ? { value: b.args } : (b.args as Record<string, unknown>),
        })
        if (wrapped)
          land(
            landings,
            b.event,
            "lossy",
            "wrapped-args",
            "non-object arguments are wrapped as { value } (tool_use.input must be an object)",
          )
        else land(landings, b.event, "exact", "tool_use")
        break
      }
    }
  }
  return out
}

/**
 * 工具表 → tools 块（L1）。有原生能力：deferLoading → `defer_loading: true`，但全表都延迟时厂商 400，退成都不延迟；
 * 无原生能力：deferLoading 的工具直接不发（模型看不见也调不了，与过滤同义）。
 */
export function encodeTools(specs: readonly ToolSpec[], deferredTools: boolean): AnthropicTool[] {
  const shown = deferredTools ? specs : specs.filter((t) => t.deferLoading !== true)
  const allDeferred = deferredTools && shown.length > 0 && shown.every((t) => t.deferLoading === true)
  return shown.map((t): AnthropicTool => {
    const tool: AnthropicTool = { name: t.name, description: t.description, input_schema: t.inputSchema }
    if (deferredTools && t.deferLoading === true && !allDeferred) tool.defer_loading = true
    return tool
  })
}

/** 数请求里块级 cache_control 的个数：system 数组、tools 数组、messages 的内容块 */
export function countBlockBreakpoints(body: AnthropicRequestBody): number {
  const has = (b: unknown) => typeof b === "object" && b !== null && "cache_control" in b
  let n = 0
  for (const s of body.system ?? []) if (has(s)) n++
  for (const t of body.tools ?? []) if (has(t)) n++
  for (const m of body.messages) for (const b of m.content) if (has(b)) n++
  return n
}

/**
 * 三处断点：system 末块、tools 末项、最后一条 user 末块。末条是 system（说明殿后）时按处置模式：
 * automatic → 顶层 cache_control（宿主 requestOptions 已给顶层的不覆盖）；previous-user → 找最后一条 user；drop → 不打。
 * 无论哪种，块级 + 顶层总数不超过 4。
 */
function placeCacheBreakpoints(body: AnthropicRequestBody, dialect: NonNullable<FetchModel["anthropic"]>) {
  const cc: AnthropicCacheControl =
    dialect.cacheTtl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" }
  const budget = () => MAX_ANTHROPIC_BREAKPOINTS - countBlockBreakpoints(body) - (body.cache_control ? 1 : 0)

  const lastSystem = body.system?.[body.system.length - 1]
  if (lastSystem && budget() > 0) lastSystem.cache_control = cc
  // defer_loading 的工具不能带 cache_control（厂商 400），断点打在最后一个非延迟工具上
  const lastTool = [...(body.tools ?? [])].reverse().find((t) => t.defer_loading !== true)
  if (lastTool && budget() > 0) lastTool.cache_control = cc

  const last = body.messages[body.messages.length - 1]
  if (!last) return
  const markLastUser = (m: AnthropicMessage | undefined) => {
    if (m?.role !== "user") return
    const block = m.content[m.content.length - 1]
    if (block && budget() > 0) block.cache_control = cc
  }
  if (last.role === "user") {
    markLastUser(last)
    return
  }
  if (last.role !== "system") return
  switch (dialect.midSystemCacheBreakpoint ?? "automatic") {
    case "automatic":
      if (body.cache_control === undefined && budget() > 0) body.cache_control = cc
      break
    case "previous-user":
      markLastUser([...body.messages].reverse().find((m) => m.role === "user"))
      break
    case "drop":
      break
  }
}
