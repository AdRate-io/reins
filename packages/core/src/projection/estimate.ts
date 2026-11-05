/**
 * 默认 token 粗估。核心包零依赖，不带任何 tokenizer；这里只求量级正确、宁高勿低，
 * 供预算裁剪兜底与感知档位使用。宿主要精确数字就注入自己的 TokenEstimator。
 *
 * 规则：ASCII 字符约 4 个一个 token；非 ASCII（中日韩等）按一字一 token 保守计；
 * 图片按 Anthropic 单图上限附近取常量；视频 / 音频按时长计；每条事件再加角色与分隔的固定开销。
 *
 * 视频 / 音频费率来源：2026-11-05 视频音频方案 P0 实测（spikes/media-parts，中转站 Gemini flash 低分辨率档）——
 * 视频每秒 91 token（含音轨，与码率、画面内容无关）、音频每秒 25；取 100 / 32 留余量（32 也是 Gemini 公开音频费率）。
 * 没有 durationSec 时按字节折算：码率实测相差约 60 倍，所以按偏低码率（视频 1 Mbps、音频 64 kbps）折算并设 30 秒下限，
 * 宁高勿低（偏高只是整理提前，偏低会溢出）。要别的费率就注入自己的 TokenEstimator，不另加开关。
 */
import {
  type AudioPart,
  type ContentPart,
  type Event,
  renderToolReference,
  type VideoPart,
} from "../events/base.js"
import type { CoreEvent } from "../events/core.js"
import type { ProjectionBudget } from "./types.js"

const PER_EVENT_OVERHEAD = 4
const IMAGE_TOKENS = 1600
const VIDEO_TOKENS_PER_SEC = 100
const AUDIO_TOKENS_PER_SEC = 32
/** 缺时长时的折算码率（字节 / 秒）：视频 1 Mbps、音频 64 kbps */
const VIDEO_BYTES_PER_SEC = 125_000
const AUDIO_BYTES_PER_SEC = 8_000
/** 缺时长时的秒数下限 */
const MIN_GUESSED_SEC = 30

/** 媒体时长：有 durationSec 用它，没有按 base64 字节数折算并取 30 秒下限 */
function mediaSeconds(part: VideoPart | AudioPart, bytesPerSec: number): number {
  if (part.durationSec !== undefined) return part.durationSec
  const bytes = (part.data.length * 3) / 4
  return Math.max(bytes / bytesPerSec, MIN_GUESSED_SEC)
}

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
    switch (p.type) {
      case "text":
        n += estimateTextTokens(p.text)
        break
      case "tool_reference":
        n += estimateTextTokens(renderToolReference(p))
        break
      case "image":
        n += IMAGE_TOKENS
        break
      case "video":
        n += Math.ceil(mediaSeconds(p, VIDEO_BYTES_PER_SEC) * VIDEO_TOKENS_PER_SEC)
        break
      case "audio":
        n += Math.ceil(mediaSeconds(p, AUDIO_BYTES_PER_SEC) * AUDIO_TOKENS_PER_SEC)
        break
      default: {
        const _exhaustive: never = p
        void _exhaustive
      }
    }
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

/**
 * 投影估算可用的 token 数：裁剪目标减去估算不含的固定开销。
 * 兜底裁剪"要不要裁、裁到哪"与 stats.overBudget 都按它判，同一口径只此一份
 */
export function estimateBudgetOf(budget: ProjectionBudget): number {
  return budget.contextLimit - budget.reserveTokens - (budget.overheadTokens ?? 0)
}
