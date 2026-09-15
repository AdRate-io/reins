/**
 * IR → OpenAI Responses 请求体，并为每条事件记落点。
 *
 * Responses 是三条线里规矩最少的一条，但有两处与"时间线是唯一真源"直接相关，这里逐条落实（规则原文 F0 实测，
 * spikes/cf-gateway-fidelity 的 R2 / R3 / R3b）：
 * - **服务端不留状态**：`store: false` 强制、宿主传的 `previous_response_id` 剥掉。每个请求把模型该看到的历史全量放进 `input`，
 *   与别的两条线同一形状；OpenAI 侧的会话状态永远不是我们依赖的东西。
 * - **reasoning 回放判据是 encrypted_content**：推理模型缺省带 `include: ["reasoning.encrypted_content"]`，上一轮的 reasoning 项
 *   （整项 JSON 存在事件 `replay.thinkingSignature` 里，与 lowering-pi 同字段）原样放回 `input`；没有加密项（未开 include、流中断）
 *   或来自别家的一律 dropped 声明，不降成正文。伪造的加密项厂商回原文 400，所以回放的必须是原件。
 * - **中途 system 不用归位**：`developer` / `system` 消息在 `input` 里任意位置合法（F0 R3 中途 developer 到达）；推理模型用
 *   developer、其它用 system（与 pi 版矩阵同格），宿主可用 `responses.systemRole` 钉死。
 * - **工具调用两个 id**：`call_id`（配对 function_call_output 用）是 core 的 toolCallId；`fc_` 项 id 存 `replay.itemId`，只在同一模型
 *   回放时带回——OpenAI 会校验 fc 项与 rs 项的配对，换了模型就不带（与 pi-ai 同一取向）。
 * - `reasoning` / `max_output_tokens` 不缺省设置：gpt-5 缺省 medium、gpt-5.1 起缺省 none，开不开由宿主按型号在 requestOptions 里定
 *   （与 Anthropic 线的 thinking 同一原则）。
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

export type ResponsesInputContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" }

export type ResponsesInputItem =
  /** user / developer / system 消息 */
  | { role: "user" | "developer" | "system"; content: ResponsesInputContent[] }
  /** 上一轮的 assistant 正文：type:message 输出项原样放回 */
  | {
      type: "message"
      role: "assistant"
      id: string
      status: "completed"
      content: { type: "output_text"; text: string; annotations: [] }[]
      phase?: string
    }
  /** 上一轮的 reasoning 项：整项原样放回（id / summary / encrypted_content 等字段以厂商给的为准） */
  | { type: "reasoning"; id: string; encrypted_content: string; [k: string]: unknown }
  | { type: "function_call"; id?: string; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string | ResponsesInputContent[] }

export interface ResponsesTool {
  type: "function"
  name: string
  description: string
  parameters: Record<string, unknown>
  /** 我们的 JSON Schema 不保证满足 strict 模式（additionalProperties:false、全部 required），一律不开 */
  strict: false
}

/** 发出去的请求体本体。宿主的 requestOptions 先铺、我们的字段后盖：model / input / tools / stream / store 不可被覆盖 */
export interface ResponsesRequestBody extends Record<string, unknown> {
  model: string
  input: ResponsesInputItem[]
  tools?: ResponsesTool[]
  stream: true
  store: false
  include?: string[]
}

export interface ResponsesEncodeInput {
  ir: readonly IrItem[]
  events: readonly Event[]
  model: FetchModel
  capabilities: LoweringCapabilities
  tools?: readonly ToolSpec[]
  systemPrompt?: string
  requestOptions?: Record<string, unknown>
}

const IMAGE_OMITTED = "[image omitted: this model does not accept images]"
const ERROR_PREFIX = "[tool error]\n"
const EMPTY_NOTE = "the content is empty, so no empty message is sent"
const ENCRYPTED_INCLUDE = "reasoning.encrypted_content"

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

/** 内容段 → 输入块；空文本段跳过，图片按模型能力处置 */
function contentOf(
  parts: readonly ContentPart[],
  images: boolean,
): { content: ResponsesInputContent[]; imagesDropped: boolean } {
  let imagesDropped = false
  const content: ResponsesInputContent[] = []
  for (const p of parts) {
    if (p.type === "text") {
      if (p.text.length > 0) content.push({ type: "input_text", text: p.text })
    } else if (p.type === "tool_reference") {
      content.push({ type: "input_text", text: renderToolReference(p) })
    } else if (images) {
      content.push({ type: "input_image", image_url: `data:${p.mime};base64,${p.data}`, detail: "auto" })
    } else {
      imagesDropped = true
      content.push({ type: "input_text", text: IMAGE_OMITTED })
    }
  }
  return { content, imagesDropped }
}

/** tool_call 入参回到线上是 JSON 字符串；读侧解析失败时存的是原始字符串，写侧原样送回 */
function argumentsOf(args: unknown): string {
  return typeof args === "string" ? args : JSON.stringify(args ?? {})
}

/**
 * 正文项的 id：本家事件的 `replay.textSignature` 是厂商给的 msg_ id、`replay.phase` 是同一项的 phase
 * （lowering-pi 把两者存成 `{"v":1,"id":…,"phase":…}` JSON 签名，两种都认）；
 * 没有就补一个——type:message 输入项要求带 id，pi-ai 也是这样补的（`msg_pi_<n>`），厂商接受。
 */
function textItemId(replay: Record<string, unknown>): { id?: string; phase?: string } {
  const sig = replay.textSignature
  if (typeof sig !== "string" || sig.length === 0) return {}
  const ownPhase = typeof replay.phase === "string" && replay.phase.length > 0 ? { phase: replay.phase } : {}
  if (sig.startsWith("{")) {
    try {
      const parsed = JSON.parse(sig) as { id?: unknown; phase?: unknown }
      if (typeof parsed.id === "string" && parsed.id.length > 0) {
        return typeof parsed.phase === "string" ? { id: parsed.id, phase: parsed.phase } : { id: parsed.id }
      }
    } catch {
      // 不是 JSON：按裸 id 处理
    }
  }
  // OpenAI 要求 id 不超过 64 字符，超长的当没有
  return sig.length > 64 ? {} : { id: sig, ...ownPhase }
}

/** replay.thinkingSignature 里存的 reasoning 项：必须是带非空 encrypted_content 的对象才可回放 */
export function reasoningItemOf(replay: Record<string, unknown>): Record<string, unknown> | undefined {
  const sig = replay.thinkingSignature
  if (typeof sig !== "string" || !sig.startsWith("{")) return undefined
  try {
    const item = JSON.parse(sig) as Record<string, unknown>
    if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) return undefined
    return item
  } catch {
    return undefined
  }
}

export function encodeResponsesRequest(input: ResponsesEncodeInput): {
  body: ResponsesRequestBody
  landings: LandingRecord[]
} {
  const { model, capabilities } = input
  const target: ModelOrigin = { provider: model.provider, api: model.api, model: model.id }
  const dialect = model.responses ?? {}
  const systemRole = dialect.systemRole ?? (model.reasoning ? "developer" : "system")
  const items: ResponsesInputItem[] = []
  const landings: LandingRecord[] = []
  let textCounter = 0

  if (input.systemPrompt)
    items.push({ role: systemRole, content: [{ type: "input_text", text: input.systemPrompt }] })

  for (const item of input.ir) {
    switch (item.kind) {
      case "user": {
        const c = contentOf(item.parts, capabilities.images)
        if (c.content.length === 0) {
          land(landings, item.event, "dropped", "none", EMPTY_NOTE)
          break
        }
        items.push({ role: "user", content: c.content })
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
        const c = contentOf(item.parts, capabilities.images)
        const hasImage = c.content.some((b) => b.type === "input_image")
        const text = c.content
          .filter((b): b is Extract<ResponsesInputContent, { type: "input_text" }> => b.type === "input_text")
          .map((b) => b.text)
          .join("\n")
        const prefixed = item.isError ? ERROR_PREFIX + text : text
        // 只有文本就用字符串（最兼容）；带图片时 output 为内容块数组（文本在前，前缀一并放进去）
        const output: string | ResponsesInputContent[] = hasImage
          ? [
              ...(prefixed.length > 0 ? [{ type: "input_text" as const, text: prefixed }] : []),
              ...c.content.filter((b) => b.type === "input_image"),
            ]
          : prefixed
        items.push({ type: "function_call_output", call_id: item.toolCallId, output })
        const lossy = item.escaped || item.isError || c.imagesDropped
        land(
          landings,
          item.event,
          lossy ? "lossy" : "exact",
          "function_call_output",
          item.isError
            ? "the Responses function_call_output has no error flag, so isError is expressed with a [tool error] prefix"
            : undefined,
          c.imagesDropped
            ? "the model takes no images, so they are replaced with placeholder text"
            : undefined,
          item.escaped ? ESCAPED_NOTE : undefined,
        )
        break
      }
      case "compaction": {
        items.push({ role: "user", content: [{ type: "input_text", text: framedSummary(item.text) }] })
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
          items.push({ role: systemRole, content: [{ type: "input_text", text: item.text }] })
          land(
            landings,
            item.event,
            item.escaped ? "lossy" : "exact",
            systemRole,
            item.escaped ? ESCAPED_NOTE : undefined,
            item.deferred ? DEFERRED_NOTE : undefined,
          )
        } else {
          items.push({
            role: "user",
            content: [{ type: "input_text", text: framedSystemNote(item.noteKind, item.text) }],
          })
          land(
            landings,
            item.event,
            "lossy",
            "user-role",
            "the host declared that this upstream does not support mid-conversation system, so it is wrapped in a <system_note> tag and sent with the user role",
            item.escaped ? ESCAPED_NOTE : undefined,
            item.deferred ? DEFERRED_NOTE : undefined,
          )
        }
        break
      }
      case "assistant": {
        const out = assistantItems(
          item.blocks,
          item.origin,
          target,
          landings,
          () => `msg_reins_${++textCounter}`,
        )
        items.push(...out)
        break
      }
      case "dropped":
        land(landings, item.event, "dropped", "none", item.note)
        break
    }
  }

  const ro = input.requestOptions ?? {}
  // input / tools 只由事件与工具表决定；previous_response_id 与"时间线是唯一真源"冲突，一律不透传
  const { input: _input, tools: _tools, previous_response_id: _prev, ...passthrough } = ro
  const body: ResponsesRequestBody = {
    ...passthrough,
    model: model.id,
    input: items,
    stream: true,
    store: false,
  }
  // Responses 没有"声明但不载入"的落点：deferLoading 的工具不发（L1）
  const shownTools = (input.tools ?? []).filter((t) => t.deferLoading !== true)
  if (shownTools.length > 0) {
    body.tools = shownTools.map(
      (t): ResponsesTool => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        strict: false,
      }),
    )
  }
  if (model.reasoning && dialect.encryptedReasoning !== false) {
    const hostInclude = Array.isArray(ro.include)
      ? ro.include.filter((x): x is string => typeof x === "string")
      : []
    body.include = hostInclude.includes(ENCRYPTED_INCLUDE) ? hostInclude : [...hostInclude, ENCRYPTED_INCLUDE]
  }
  return { body, landings: orderLandings(input.events, landings) }
}

/**
 * 一轮模型输出 → 输出项列表（Responses 的 assistant 一轮是多个独立项，不像别家是一条消息里的多个块）。
 * - 正文：每段一个 type:message 项，id 同家回放、否则补；空段 dropped；
 * - reasoning：同家且 replay 里是带 encrypted_content 的整项 → 原样放回；别家 / 没有加密项 → dropped；
 * - tool_call：function_call，arguments 是 JSON 字符串；fc_ 项 id 只在同一模型时带回。
 */
function assistantItems(
  blocks: readonly IrBlock[],
  origin: ModelOrigin,
  target: ModelOrigin,
  landings: LandingRecord[],
  nextTextId: () => string,
): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = []
  const foreign = foreignOrigin(origin, target)
  const sameModel = !foreign && origin.model === target.model
  for (const b of blocks) {
    switch (b.type) {
      case "text": {
        if (b.text.length === 0) {
          land(landings, b.event, "dropped", "none", EMPTY_NOTE)
          break
        }
        const own = foreign ? {} : textItemId(b.replay)
        const id = own.id ?? nextTextId()
        out.push({
          type: "message",
          role: "assistant",
          id,
          status: "completed",
          content: [{ type: "output_text", text: b.text, annotations: [] }],
          ...(own.phase !== undefined ? { phase: own.phase } : {}),
        })
        land(
          landings,
          b.event,
          "exact",
          "assistant-message",
          own.id === undefined ? "the item id is supplied by this package" : undefined,
        )
        break
      }
      case "thinking": {
        if (foreign) {
          land(
            landings,
            b.event,
            "dropped",
            "none",
            `reasoning from ${origin.provider}/${origin.api} has no encrypted item of its own, so it is not replayed`,
          )
          break
        }
        // 加密项绑定产出它的模型（与 fc_ 项 id 同一取向）：换了型号不放回，声明 dropped
        if (!sameModel) {
          land(
            landings,
            b.event,
            "dropped",
            "none",
            `the reasoning item comes from ${origin.model}, but this request targets ${target.model}; encrypted reasoning is only valid for the model that produced it, so it is not replayed`,
          )
          break
        }
        const item = reasoningItemOf(b.replay)
        if (!item) {
          land(
            landings,
            b.event,
            "dropped",
            "none",
            "the reasoning item has no encrypted_content (it was not requested, or the stream broke), so it cannot be replayed under store:false",
          )
          break
        }
        out.push({ ...item, type: "reasoning" } as Extract<ResponsesInputItem, { type: "reasoning" }>)
        land(landings, b.event, "exact", "reasoning-item")
        break
      }
      case "tool_call": {
        const itemId = sameModel && typeof b.replay.itemId === "string" ? b.replay.itemId : undefined
        out.push({
          type: "function_call",
          ...(itemId !== undefined ? { id: itemId } : {}),
          call_id: b.id,
          name: b.name,
          arguments: argumentsOf(b.args),
        })
        land(
          landings,
          b.event,
          "exact",
          "function_call",
          itemId === undefined && typeof b.replay.itemId === "string"
            ? "the model changed, so the fc_ item id is not carried back"
            : undefined,
        )
        break
      }
    }
  }
  return out
}
