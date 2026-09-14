/**
 * 默认 token 粗估。核心包零依赖，不带任何 tokenizer；这里只求量级正确、宁高勿低，
 * 供预算裁剪兜底与感知档位使用。宿主要精确数字就注入自己的 TokenEstimator。
 *
 * 规则：ASCII 字符约 4 个一个 token；非 ASCII（中日韩等）按一字一 token 保守计；
 * 图片按 Anthropic 单图上限附近取常量；每条事件再加角色与分隔的固定开销。
 */
import { type ContentPart, type Event, renderToolReference } from "../events/base.js"
import type { CoreEvent } from "../events/core.js"

const PER_EVENT_OVERHEAD = 4
const IMAGE_TOKENS = 1600

export function estimateTextTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4) + other
}

function partsTokens(parts: readonly ContentPart[]): number {
  let n = 0
  for (const p of parts) {
    if (p.type === "text") n += estimateTextTokens(p.text)
    else if (p.type === "tool_reference") n += estimateTextTokens(renderToolReference(p))
    else n += IMAGE_TOKENS
  }
  return n
}

/** JSON.stringify 对 undefined / 函数返回 undefined，这里统一成空串 */
function safeJson(value: unknown): string {
  const s = JSON.stringify(value)
  return typeof s === "string" ? s : ""
}

export function roughTokenEstimate(event: Event): number {
  const e = event as CoreEvent
  let body: number
  switch (e.type) {
    case "core.user_message":
      body = partsTokens(e.payload.content)
      break
    case "core.tool_result":
      body = partsTokens(e.payload.content) + estimateTextTokens(e.payload.name)
      break
    case "core.model_text":
    case "core.model_thinking":
    case "core.system_note":
      body = estimateTextTokens(e.payload.text)
      break
    case "core.tool_call":
      body = estimateTextTokens(e.payload.name) + estimateTextTokens(safeJson(e.payload.args))
      break
    case "core.compaction":
    case "core.handoff":
      body = estimateTextTokens(e.payload.summary)
      break
    default:
      // ext.* 与其余 core.*：按整个 payload 序列化后的长度估
      body = estimateTextTokens(safeJson(event.payload))
  }
  return body + PER_EVENT_OVERHEAD
}

export function estimateTotal(events: readonly Event[], estimate: (e: Event) => number): number {
  let n = 0
  for (const e of events) n += estimate(e)
  return n
}
