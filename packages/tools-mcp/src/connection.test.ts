/**
 * McpConnection 的生命周期边界：正在建连时 close 不能让连接漏掉（2026-09-10 审查修）。
 * 其余路径（懒建、复用、断了重建、服务器死掉）由 mcp-tools.test.ts 端到端覆盖。
 */
import { describe, expect, it } from "vitest"
import { McpConnection } from "./connection.js"
import { fixtureServer } from "./test-utils.js"

const INFO = { name: "reins-test", version: "0.0.0" }

describe("McpConnection.close", () => {
  it("建连进行中调用 close：等建连有结果再关，之后不持有连接；再需要时重新建连", async () => {
    const fx = fixtureServer()
    const conn = new McpConnection(fx.transport, { clientInfo: INFO })
    // 不 await：让 ensure() 停在 connect 里
    const inflight = conn.listTools().catch(() => "closed-underneath")
    expect(conn.connected).toBe(false)
    await conn.close()
    await inflight
    // 修复前：close 只清了当时还是 undefined 的引用，建连完成后连接被挂回来，这里会是 true
    expect(conn.connected).toBe(false)
    expect(fx.connects).toBe(1)
    // 关掉的连接不复用：下一次需要时按配方重建
    const tools = await conn.listTools()
    expect(tools.map((t) => t.name)).toContain("echo")
    expect(fx.connects).toBe(2)
    await conn.close()
  })

  it("建连失败时 close 不抛：没有连接可关", async () => {
    const fx = fixtureServer()
    fx.down = true
    const conn = new McpConnection(fx.transport, { clientInfo: INFO })
    const inflight = conn.listTools()
    await expect(conn.close()).resolves.toBeUndefined()
    await expect(inflight).rejects.toThrow(/连接失败/)
    expect(conn.connected).toBe(false)
  })

  it("没建过连接时 close 是空操作", async () => {
    const conn = new McpConnection(fixtureServer().transport, { clientInfo: INFO })
    await expect(conn.close()).resolves.toBeUndefined()
    expect(conn.connected).toBe(false)
  })
})
