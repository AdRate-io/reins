import { describe, expect, it } from "vitest"
import { toolCallArgumentsMeta, unwrapToolArguments } from "./tool-arguments.js"

describe("工具入参二次编码（core/lowering/tool-arguments.ts，OnSet 建议 8）", () => {
  it("解一次得字符串、该字符串能解成对象 → 换成对象并标 unwrapped", () => {
    const once = JSON.parse(
      JSON.stringify(JSON.stringify({ candidate_for: "a", prompt: '他说："走"' })),
    ) as unknown
    expect(typeof once).toBe("string")
    const d = unwrapToolArguments(once)
    expect(d).toEqual({ args: { candidate_for: "a", prompt: '他说："走"' }, unwrapped: true })
    expect(toolCallArgumentsMeta(d)).toEqual({ meta: { argumentsUnwrapped: true } })
  })

  it("只多解一层：三次编码解两层后仍是字符串，原样返回", () => {
    const twice = JSON.stringify(JSON.stringify({ a: 1 }))
    expect(unwrapToolArguments(twice)).toEqual({ args: twice, unwrapped: false })
  })

  it("对象、解析不了的原始文本、数组 / 数字 / null 文本一律原样，不带 meta", () => {
    for (const v of [{ a: 1 }, {}, "{broken", "plain text", "[1,2]", "42", "null", '"x"', 7, null]) {
      const d = unwrapToolArguments(v)
      expect(d).toEqual({ args: v, unwrapped: false })
      expect(toolCallArgumentsMeta(d)).toEqual({})
    }
  })
})
