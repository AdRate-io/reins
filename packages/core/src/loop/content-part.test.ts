/**
 * isContentPart：片段形状的唯一真源（工具返回值与 runLoop 输入共用），视频 / 音频边界（2026-11-05 方案）
 */
import { describe, expect, it } from "vitest"
import { isContentPart, isSupportedImageMime, normalizeToolOutput, unsupportedImageText } from "./tools.js"

describe("isContentPart：视频 / 音频", () => {
  it.each([
    ["video 有时长", { type: "video", mime: "video/mp4", data: "AA", durationSec: 72 }],
    ["video 无时长", { type: "video", mime: "video/webm", data: "AA" }],
    ["audio 小数时长", { type: "audio", mime: "audio/mpeg", data: "AA", durationSec: 0.25 }],
    ["audio 无时长", { type: "audio", mime: "audio/wav", data: "" }],
  ])("%s → 合规", (_name, part) => {
    expect(isContentPart(part)).toBe(true)
  })

  it.each([
    ["video mime 是 audio/", { type: "video", mime: "audio/mpeg", data: "AA" }],
    ["audio mime 是 video/", { type: "audio", mime: "video/mp4", data: "AA" }],
    ["mime 只是前缀词", { type: "video", mime: "video", data: "AA" }],
    ["mime 缺", { type: "audio", data: "AA" }],
    ["data 不是字符串", { type: "video", mime: "video/mp4", data: 1 }],
    ["durationSec 0", { type: "video", mime: "video/mp4", data: "AA", durationSec: 0 }],
    ["durationSec 负数", { type: "audio", mime: "audio/wav", data: "AA", durationSec: -3 }],
    ["durationSec NaN", { type: "audio", mime: "audio/wav", data: "AA", durationSec: Number.NaN }],
    [
      "durationSec Infinity",
      { type: "video", mime: "video/mp4", data: "AA", durationSec: Number.POSITIVE_INFINITY },
    ],
    ["durationSec null", { type: "video", mime: "video/mp4", data: "AA", durationSec: null }],
  ])("%s → 不合规", (_name, part) => {
    expect(isContentPart(part)).toBe(false)
  })
})

describe("isContentPart：图片 mime 白名单（全库审查 2026-11-25 #9）", () => {
  it.each(["image/jpeg", "image/png", "image/gif", "image/webp"])("内联 %s → 合规", (mime) => {
    expect(isSupportedImageMime(mime)).toBe(true)
    expect(isContentPart({ type: "image", mime, data: "AA" })).toBe(true)
    expect(isContentPart({ type: "image", mime, blobId: "b1" })).toBe(true)
  })

  it.each(["image/svg+xml", "image/heic", "image/jpg", "IMAGE/PNG", "text/plain", "video/mp4", "image/", ""])(
    "%s → 内联与引用都不合规（厂商只收四种，写进日志后每轮 400、会话卡死）",
    (mime) => {
      expect(isSupportedImageMime(mime)).toBe(false)
      expect(isContentPart({ type: "image", mime, data: "AA" })).toBe(false)
      expect(isContentPart({ type: "image", mime, blobId: "b1" })).toBe(false)
    },
  )

  it("非字符串 mime 不合规", () => {
    expect(isSupportedImageMime(undefined)).toBe(false)
    expect(isSupportedImageMime(1)).toBe(false)
  })

  it("工具返回不支持的图片：只把那一段换成说明，其余片段照旧，不以图片片段进日志、base64 不进上下文", () => {
    const text = { type: "text", text: "chart below" }
    const png = { type: "image", mime: "image/png", data: "AA" }
    const svg = { type: "image", mime: "image/svg+xml", data: "PHN2Zy8+" }
    const note = { type: "text", text: unsupportedImageText("image/svg+xml") }
    expect(normalizeToolOutput([text, svg, png])).toEqual({ content: [text, note, png] })
    // { content, isError } 形态同样逐段换，isError 保留
    expect(normalizeToolOutput({ content: [svg], isError: true })).toEqual({ content: [note], isError: true })
    // 引用形态同样
    const ref = { type: "image", mime: "image/heic", blobId: "b1" }
    expect(normalizeToolOutput([ref])).toEqual({
      content: [{ type: "text", text: unsupportedImageText("image/heic") }],
    })
    expect(note.text).not.toContain("PHN2Zy8+")
  })

  it("白名单外图片之外还有别的坏片段：仍整个 JSON 化（只逐段换图片 mime 这一种）", () => {
    const mixed = [
      { type: "image", mime: "image/svg+xml", data: "PHN2Zy8+" },
      { type: "audio", mime: "audio/mpeg", data: "AA", durationSec: 0 },
    ]
    expect(normalizeToolOutput(mixed)).toEqual({ content: [{ type: "text", text: JSON.stringify(mixed) }] })
    // data 与 blobId 同时给不是"只差 mime"
    const both = [{ type: "image", mime: "image/svg+xml", data: "AA", blobId: "b1" }]
    expect(normalizeToolOutput(both)).toEqual({ content: [{ type: "text", text: JSON.stringify(both) }] })
  })

  it("tool_reference 的 inputSchema 不能是数组", () => {
    expect(isContentPart({ type: "tool_reference", name: "g", description: "d", inputSchema: [] })).toBe(
      false,
    )
  })

  it("工具返回合规媒体片段原样成为结果；坏片段整个当普通值 JSON 化", () => {
    const good = [{ type: "video", mime: "video/mp4", data: "AA", durationSec: 6 }]
    expect(normalizeToolOutput(good)).toEqual({ content: good })
    const bad = [{ type: "audio", mime: "audio/mpeg", data: "AA", durationSec: 0 }]
    expect(normalizeToolOutput(bad)).toEqual({ content: [{ type: "text", text: JSON.stringify(bad) }] })
  })
})
