import { defineTool } from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import { ownsTool, shadowingToolName, ToolIdentitySet } from "./own-tools.js"

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

describe("isSameTool 一个口径：setup 守卫与 ToolIdentitySet", () => {
  it("宿主把模块工具的副本放进自己的工具表不算撞名；别家同名照样算", () => {
    expect(shadowingToolName([{ ...mine, description: "改过" }], [mine])).toBeUndefined()
    const other = defineTool({
      name: "fetch_blob",
      description: "别家",
      inputSchema: { type: "object" },
      execute: () => "y",
    })
    expect(shadowingToolName([other], [mine])).toBe("fetch_blob")
    expect(shadowingToolName([mine], ["fetch_blob"])).toBe("fetch_blob")
  })

  it("ToolIdentitySet 认原件与保留 execute 的副本，不认别家同名、包过的替身、没有 execute 时的副本", () => {
    const set = new ToolIdentitySet()
    set.add(mine)
    expect(set.has(mine)).toBe(true)
    expect(set.has({ ...mine })).toBe(true)
    expect(set.has({ ...mine, execute: () => "z" })).toBe(false)
    const client = defineTool({
      name: "pick",
      description: "前端",
      inputSchema: { type: "object" },
      side: "client",
    })
    set.add(client)
    expect(set.has(client)).toBe(true)
    expect(set.has({ ...client })).toBe(false)
  })
})
