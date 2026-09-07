import { describe, expect, it } from "vitest"
import { REINS_VERSION } from "./index.js"

describe("skeleton", () => {
  it("exports a version", () => {
    expect(REINS_VERSION).toBe("0.0.0")
  })
})
