/**
 * 媒体片段（图片 / 视频 / 音频）的共用判定与占位文案：三条线协议共用一份（2026-11-05 视频音频方案）。
 *
 * 规则：能力位为真时三条线都放进该线的**图片槽**（mime 原样），为假时落文字占位、事件记 lossy。
 *
 * ⚠️ 视频 / 音频走图片槽是**中转站方言**（P0 实测：公司中转站 Gemini 三线 × user / 工具结果都认，三家官方端点都不收）。
 * 所以内置模型表一律不开 `video` / `audio`，只由宿主对自己的中转站模型声明。
 * ⚠️ 绝不改用 `input_audio`（"官方写法"）：中转站对它回 200 却把音频静默丢掉、模型编造内容，比报错更糟（踩坑 45）。
 */
import type { AudioPart, ContentPart, ImagePart, LoweringCapabilities, VideoPart } from "@reinsjs/core"

export type MediaPart = ImagePart | VideoPart | AudioPart
export type MediaKind = MediaPart["type"]

export function isMediaPart(p: ContentPart): p is MediaPart {
  return p.type === "image" || p.type === "video" || p.type === "audio"
}

/** 模型收不收这类媒体：图片看必填的 `images`，视频 / 音频看可选位、没写 = 不收（fail-closed） */
export function acceptsMedia(kind: MediaKind, capabilities: LoweringCapabilities): boolean {
  switch (kind) {
    case "image":
      return capabilities.images
    case "video":
      return capabilities.video === true
    case "audio":
      return capabilities.audio === true
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

/** 时长写法："72 s"；非整数保留一位小数 */
function durationText(sec: number): string {
  return `${Number.isInteger(sec) ? sec : sec.toFixed(1)} s`
}

/**
 * 模型不收这类媒体时的占位。图片的文案与改动前逐字节一致（历史请求、缓存前缀不变）；
 * 视频 / 音频带上 mime 与时长（有才写），模型至少知道"这里原本有什么"
 */
export function mediaOmitted(p: MediaPart): string {
  if (p.type === "image") return "[image omitted: this model does not accept images]"
  const detail = p.durationSec !== undefined ? `${p.mime}, ${durationText(p.durationSec)}` : p.mime
  return `[${p.type} omitted: this model does not accept ${p.type} (${detail})]`
}

/** 复数名词：落点 note 里用（图片沿用 "images"，与改动前的 note 一致） */
const KIND_NOUN: Readonly<Record<MediaKind, string>> = {
  image: "images",
  video: "video clips",
  audio: "audio clips",
}

/** 被换成占位的媒体种类 → "images / video clips"；空集给 undefined */
export function mediaNouns(kinds: ReadonlySet<MediaKind>): string | undefined {
  if (kinds.size === 0) return undefined
  return (["image", "video", "audio"] as const)
    .filter((k) => kinds.has(k))
    .map((k) => KIND_NOUN[k])
    .join(" / ")
}

/**
 * 被换成占位的媒体种类 → 落点 note。只有图片时与改动前逐字一致
 * （"the model takes no images, so they are replaced with placeholder text"）
 */
export function omittedNote(kinds: ReadonlySet<MediaKind>): string | undefined {
  const names = mediaNouns(kinds)
  return names ? `the model takes no ${names}, so they are replaced with placeholder text` : undefined
}

/** 有视频 / 音频真的进了图片槽时附的方言说明（落点仍算 exact：内容完整送达） */
export const RELAY_DIALECT_NOTE =
  "relay dialect: video / audio travel in the image slot; official endpoints reject this, so declare video / audio only for endpoints that take it"
