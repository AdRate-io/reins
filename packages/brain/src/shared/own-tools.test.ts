import { defineTool } from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import { ownsTool } from "./own-tools.js"

const mine = defineTool({
  name: "fetch_blob",
  description: "取回",
  inputSchema: { type: "object" },
  execute: () => "x",
})

describe("ownsTool：本轮绑定的是不是自家工具", () => {
  it("同一对象、或保留同一个 execute 的浅拷贝算自家的", () => {
    expect(ownsTool({ tools: [mine] }, mine)).toBe(true)
    expect(ownsTool({ tools: [{ ...mine, description: "改过的说明" }] }, mine)).toBe(true)
  })

  it("别人的同名工具、包了一层 execute 的替身、表里没有都不算", () => {
    const other = defineTool({
      name: "fetch_blob",
      description: "别家",
      inputSchema: { type: "object" },
      execute: () => "y",
    })
    const wrapped = {
      ...mine,
      execute: (...args: Parameters<NonNullable<typeof mine.execute>>) => mine.execute?.(...args),
    }
    expect(ownsTool({ tools: [other] }, mine)).toBe(false)
    expect(ownsTool({ tools: [wrapped] }, mine)).toBe(false)
    expect(ownsTool({ tools: [] }, mine)).toBe(false)
  })
})
