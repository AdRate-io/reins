import { describe, expect, it } from "vitest"
import { modelToolName, riskOf, toContentParts, toToolInfo } from "./translate.js"

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
    expect(() => toToolInfo(null)).toThrow("对象")
  })
})

describe("toContentParts：MCP 内容块 → reins 内容片段，有损处明说", () => {
  it("text / image 原样；audio、resource_link、二进制 resource 翻成说明文字；文本 resource 带 uri 头；图片 resource 成图片", () => {
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
      { type: "text", text: "[audio audio/wav, 5 bytes; audio cannot be shown to the model]" },
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
  it("content 为空：有 structuredContent 用它的 JSON，否则空文本", () => {
    expect(toContentParts({ content: [], structuredContent: { a: 1 } })).toEqual([
      { type: "text", text: '{"a":1}' },
    ])
    expect(toContentParts({})).toEqual([{ type: "text", text: "" }])
  })
})
