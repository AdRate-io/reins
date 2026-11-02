import { describe, expect, it } from "vitest"
import { decodeToolArgumentsText, toolCallArgumentsMeta, unwrapToolArguments } from "./tool-arguments.js"

describe("工具入参二次编码（core/lowering/tool-arguments.ts，OnSet 建议 8）", () => {
  it("unwrapToolArguments：字符串能解成对象 → 换成对象并标 unwrapped", () => {
    const once = JSON.parse(
      JSON.stringify(JSON.stringify({ candidate_for: "a", prompt: '他说："走"' })),
    ) as unknown
    expect(typeof once).toBe("string")
    const d = unwrapToolArguments(once)
    expect(d).toEqual({ args: { candidate_for: "a", prompt: '他说："走"' }, unwrapped: true })
    expect(toolCallArgumentsMeta(d)).toEqual({ meta: { argumentsUnwrapped: true } })
  })

  it("unwrapToolArguments：内层字符串里的裸换行 / 制表符照样解开（模型二次编码时常欠转义）；字面量外的换行不动", () => {
    const d = unwrapToolArguments('{\n  "prompt": "第一行\n第二行\t尾",\n  "n": 1\n}')
    expect(d).toEqual({ args: { prompt: "第一行\n第二行\t尾", n: 1 }, unwrapped: true })
  })

  it("unwrapToolArguments：对象、解析不了的文本、数组 / 数字 / null 文本一律原样，不带 meta", () => {
    for (const v of [{ a: 1 }, {}, "{broken", "plain text", "[1,2]", "42", "null", '"x"', 7, null]) {
      const d = unwrapToolArguments(v)
      expect(d).toEqual({ args: v, unwrapped: false })
      expect(toolCallArgumentsMeta(d)).toEqual({})
    }
  })

  it("decodeToolArgumentsText：只多解一层；没解成对象的字符串一律存线上原文（args 是字符串 ⟺ 原文）", () => {
    const wire = (v: unknown) => JSON.stringify(v)
    expect(decodeToolArgumentsText(wire({ a: 1 }))).toEqual({ args: { a: 1 }, unwrapped: false })
    expect(decodeToolArgumentsText(wire(wire({ a: 1 })))).toEqual({ args: { a: 1 }, unwrapped: true })
    for (const raw of [
      wire(wire(wire({ a: 1 }))),
      wire("[1,2]"),
      wire("hello"),
      wire("42"),
      "{broken",
      "  ",
    ]) {
      const d = decodeToolArgumentsText(raw)
      expect(d.unwrapped).toBe(false)
      expect(d.args).toEqual(raw.trim() === "" ? {} : raw)
    }
    expect(decodeToolArgumentsText("[1,2]")).toEqual({ args: [1, 2], unwrapped: false })
    expect(decodeToolArgumentsText("42")).toEqual({ args: 42, unwrapped: false })
  })
})
