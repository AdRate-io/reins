import { describe, expect, it } from "vitest"
import { LoweringError } from "../lowering/errors.js"
import { backoffDelayMs, defaultSleep, isTransientFailure, resolveRetry } from "./retry.js"

describe("retry：瞬断判定与退避", () => {
  it("网络错误码、被掐、超时、过载 / 限流 / 5xx 算瞬断；4xx 参数错、缺 key、宿主中止不算", () => {
    const thrown = (error: unknown) => isTransientFailure({ kind: "thrown", error })
    const outcome = (message: string) => isTransientFailure({ kind: "outcome", message })
    expect(thrown(new Error("ECONNRESET"))).toBe(true)
    expect(thrown(Object.assign(new Error("fetch failed"), { cause: { code: "ETIMEDOUT" } }))).toBe(true)
    expect(thrown(new Error("Connection error."))).toBe(true)
    expect(outcome("terminated")).toBe(true) // E3 实测 pi-ai 的报法
    expect(outcome("529 overloaded")).toBe(true)
    expect(outcome("Rate limit exceeded (429)")).toBe(true)
    expect(outcome("502 Bad Gateway")).toBe(true)
    expect(outcome("pi-ai 流在 done / error 之前就结束了")).toBe(true)

    expect(outcome("400 invalid_request_error: messages.3.content is empty")).toBe(false)
    expect(outcome("401 authentication_error")).toBe(false)
    expect(thrown(new LoweringError("missing_api_key", "未配置 key"))).toBe(false)
    expect(thrown(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))).toBe(false)
    expect(thrown("some string")).toBe(false)
    expect(thrown(null)).toBe(false)
  })

  it("退避：base × 2^(attempt−1)，封顶 maxDelay；maxAttempts 非法在构造时拒绝", () => {
    expect([1, 2, 3, 4, 5].map((a) => backoffDelayMs(a))).toEqual([1000, 2000, 4000, 8000, 8000])
    expect(backoffDelayMs(3, { baseDelayMs: 100, maxDelayMs: 250 })).toBe(250)
    expect(resolveRetry().maxAttempts).toBe(3)
    expect(() => resolveRetry({ maxAttempts: 0 })).toThrow(RangeError)
    expect(() => resolveRetry({ maxAttempts: 1.5 })).toThrow(RangeError)
  })

  it("defaultSleep：signal 中止立刻返回", async () => {
    const ac = new AbortController()
    const started = Date.now()
    const p = defaultSleep(60_000, ac.signal)
    ac.abort()
    await p
    expect(Date.now() - started).toBeLessThan(1000)
    ac.abort()
    await defaultSleep(60_000, ac.signal) // 已中止的 signal：不等
  })
})
