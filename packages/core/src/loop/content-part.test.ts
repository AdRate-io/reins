/**
 * isContentPart：片段形状的唯一真源（工具返回值与 runLoop 输入共用），视频 / 音频边界（2026-11-05 方案）
 */
import { describe, expect, it } from "vitest"
import { isContentPart, normalizeToolOutput } from "./tools.js"

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

  it("image 的 mime 维持不校验（历史行为，收紧是破坏性变更）", () => {
    expect(isContentPart({ type: "image", mime: "video/mp4", data: "AA" })).toBe(true)
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
