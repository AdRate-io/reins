import { describe, expect, it } from "vitest"
import { uuidv7 } from "./id.js"

describe("uuidv7", () => {
  it("格式符合 RFC 9562：版本 7、变体 10xx", () => {
    for (let i = 0; i < 100; i++) {
      expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
  })

  it("前 48 位是毫秒时间戳，字典序即时间序", () => {
    const a = uuidv7(1_700_000_000_000)
    const b = uuidv7(1_700_000_000_001)
    expect(a < b).toBe(true)
    expect(Number.parseInt(a.replace(/-/g, "").slice(0, 12), 16)).toBe(1_700_000_000_000)
  })

  it("不重复", () => {
    const set = new Set(Array.from({ length: 10_000 }, () => uuidv7()))
    expect(set.size).toBe(10_000)
  })
})
