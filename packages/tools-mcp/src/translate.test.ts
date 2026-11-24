import { describe, expect, it } from "vitest"
import { modelToolName, modelToolNames, riskOf, toContentParts, toToolInfo } from "./translate.js"

describe("modelToolName：模型侧工具名", () => {
  it("合规名字原样；加前缀；非法字符换 _；截到 64", () => {
    expect(modelToolName("get_weather")).toBe("get_weather")
    expect(modelToolName("get_weather", "gh_")).toBe("gh_get_weather")
    expect(modelToolName("files.read", "fs-")).toBe("fs-files_read")
    expect(modelToolName("a".repeat(80))).toHaveLength(64)
    expect(modelToolName("中文")).toBe("__")
    expect(modelToolName("")).toBe("_")
  })
})

describe("modelToolNames：一台服务器的模型侧名字互不相同", () => {
  it("合规原名先占名（与列出顺序无关）；改写后撞名按原名排序追加 _2、_3；后缀让位截断仍 ≤ 64", () => {
    expect(modelToolNames(["a.b", "a_b"])).toEqual(["a_b_2", "a_b"])
    // "a b"（空格 0x20）排在 "a.b"（0x2e）前，先拿 _2
    expect(modelToolNames(["a.b", "a-b", "a b", "a_b"])).toEqual(["a_b_3", "a-b", "a_b_2", "a_b"])
    expect(modelToolNames(["a.b", "a_b_2", "a_b"])).toEqual(["a_b_3", "a_b_2", "a_b"])
    const long = "y".repeat(70)
    const names = modelToolNames([`${long}1`, `${long}2`], "p_")
    expect(names).toEqual([`p_${"y".repeat(62)}`, `p_${"y".repeat(60)}_2`])
    expect(names.every((n) => n.length <= 64)).toBe(true)
    expect(modelToolNames(["ok", "files.read"])).toEqual(["ok", "files_read"])
  })

  it("改写名不随服务器列出顺序变：同一组原名任意顺序列出，每个原名拿到的模型侧名字相同", () => {
    const names = ["a.b", "a b", "a/b", "a_b", "c.d"]
    const expected = new Map(names.map((n, i) => [n, modelToolNames(names)[i]]))
    for (const order of [[...names].reverse(), ["c.d", "a/b", "a_b", "a b", "a.b"]]) {
      const got = modelToolNames(order)
      expect(new Map(order.map((n, i) => [n, got[i]]))).toEqual(expected)
    }
  })
})

describe("riskOf：注解只定缺省风险档", () => {
  it("readOnly → low；destructive → high；其余（含无注解）→ medium", () => {
    expect(riskOf({ readOnlyHint: true })).toBe("low")
    expect(riskOf({ destructiveHint: true })).toBe("high")
    // 两个都写了以破坏性为准：宁可多问一次
    expect(riskOf({ readOnlyHint: true, destructiveHint: true })).toBe("high")
    expect(riskOf({ destructiveHint: false })).toBe("medium")
    expect(riskOf(undefined)).toBe("medium")
  })
})

describe("toToolInfo：服务器声明 → 纯数据", () => {
  it("取 name / title / description / inputSchema / outputSchema / annotations，其余忽略", () => {
    const info = toToolInfo({
      name: "echo",
      title: "Echo",
      description: "d",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      icons: [],
      _meta: { x: 1 },
    })
    expect(info).toEqual({
      name: "echo",
      title: "Echo",
      description: "d",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    })
  })
  it("缺 name 或 inputSchema 抛错（服务器声明不合法，宁可起步失败）", () => {
    expect(() => toToolInfo({ inputSchema: {} })).toThrow("name")
    expect(() => toToolInfo({ name: "x" })).toThrow("inputSchema")
    expect(() => toToolInfo(null)).toThrow("is not an object")
  })
})

describe("toContentParts：MCP 内容块 → reins 内容片段，有损处明说", () => {
  it("text / image / audio 原样；resource_link、二进制 resource 翻成说明文字；文本 resource 带 uri 头；图片 resource 成图片", () => {
    const parts = toContentParts({
      content: [
        { type: "text", text: "t" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
        {
          type: "resource_link",
          uri: "file:///x.txt",
          name: "x.txt",
          mimeType: "text/plain",
          description: "notes",
        },
        { type: "resource", resource: { uri: "file:///y.txt", mimeType: "text/plain", text: "inline text" } },
        {
          type: "resource",
          resource: { uri: "file:///z.bin", mimeType: "application/octet-stream", blob: "aGVsbG8=" },
        },
        { type: "resource", resource: { uri: "file:///p.png", mimeType: "image/png", blob: "aGVsbG8=" } },
        { type: "weird", foo: 1 },
      ],
    })
    expect(parts).toEqual([
      { type: "text", text: "t" },
      { type: "image", mime: "image/png", data: "aGVsbG8=" },
      { type: "audio", mime: "audio/wav", data: "aGVsbG8=" },
      { type: "text", text: "Resource link: file:///x.txt (x.txt) [text/plain] — notes" },
      { type: "text", text: "[resource file:///y.txt (text/plain)]\ninline text" },
      {
        type: "text",
        text: "[binary resource file:///z.bin (application/octet-stream), 5 bytes; not shown to the model]",
      },
      { type: "image", mime: "image/png", data: "aGVsbG8=" },
      { type: "text", text: '{"type":"weird","foo":1}' },
    ])
  })
  it("视频 / 音频（2026-11-05）：resource blob 按 mime 前缀成片段（没有时长）；audio 块缺 data 或 mime 不对仍落说明", () => {
    expect(
      toContentParts({
        content: [
          { type: "resource", resource: { uri: "file:///c.mp4", mimeType: "video/mp4", blob: "aGVsbG8=" } },
          { type: "resource", resource: { uri: "file:///c.mp3", mimeType: "audio/mpeg", blob: "aGVsbG8=" } },
          { type: "audio", data: "aGVsbG8=", mimeType: "application/octet-stream" },
          { type: "audio", mimeType: "audio/wav" },
        ],
      }),
    ).toEqual([
      { type: "video", mime: "video/mp4", data: "aGVsbG8=" },
      { type: "audio", mime: "audio/mpeg", data: "aGVsbG8=" },
      { type: "text", text: "[audio application/octet-stream, 5 bytes; audio cannot be shown to the model]" },
      { type: "text", text: "[audio audio/wav, 0 bytes; audio cannot be shown to the model]" },
    ])
  })

  it("content 为空：有 structuredContent 用它的 JSON，否则空文本", () => {
    expect(toContentParts({ content: [], structuredContent: { a: 1 } })).toEqual([
      { type: "text", text: '{"a":1}' },
    ])
    expect(toContentParts({})).toEqual([{ type: "text", text: "" }])
  })
})
