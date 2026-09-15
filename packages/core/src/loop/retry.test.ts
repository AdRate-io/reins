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
    expect(outcome("the pi-ai stream ended before done / error")).toBe(true)

    expect(outcome("400 invalid_request_error: messages.3.content is empty")).toBe(false)
    expect(outcome("401 authentication_error")).toBe(false)
    expect(thrown(new LoweringError("missing_api_key", "未配置 key"))).toBe(false)
    expect(thrown(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))).toBe(false)
    expect(thrown(Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" }))).toBe(
      false,
    )
    expect(thrown("some string")).toBe(false)
    expect(thrown(null)).toBe(false)
  })

  it("R3：有状态码就只按状态码定，正文里的 timeout / 429 / 409 字样不算；没有状态码才看关键词，裸数字不再匹配", () => {
    const thrown = (error: unknown) => isTransientFailure({ kind: "thrown", error })
    const outcome = (message: string) => isTransientFailure({ kind: "outcome", message })
    // Anthropic SDK 的 message 格式："<status> <body>"，pi-ai 原样转成 errorMessage
    expect(
      outcome(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"timeout must be between 1 and 600; request 429 rejected"}}',
      ),
    ).toBe(false)
    expect(outcome("422 Unprocessable: connection error field is invalid, status 409 mentioned")).toBe(false)
    expect(outcome('529 {"type":"error","error":{"type":"overloaded_error"}}')).toBe(true)
    expect(outcome("409 lock timeout")).toBe(true) // 与 SDK / pi-ai provider-retry 同策略：408 / 409 / 429 / 5xx
    expect(outcome("Request failed with status code 503")).toBe(true) // 状态码不在开头的常见写法
    expect(outcome("HTTP 400 Bad Request: rate limit parameter unknown")).toBe(false)
    // 没有状态码：关键词兜底，裸数字不算
    expect(outcome("Request timed out.")).toBe(true)
    expect(outcome("upstream returned 503")).toBe(false)
    expect(outcome("error code 429 in payload id")).toBe(false)
    // 抛出的错误：结构化 status 优先于文案
    expect(thrown(Object.assign(new Error("400 connection error in field"), { status: 400 }))).toBe(false)
    expect(thrown(Object.assign(new Error("boom"), { status: 503 }))).toBe(true)
    // SDK 连接层错误类名、x-should-retry 响应头
    expect(
      thrown(Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" })),
    ).toBe(true)
    expect(
      thrown(
        Object.assign(new Error("500 boom"), {
          status: 500,
          headers: new Headers({ "x-should-retry": "false" }),
        }),
      ),
    ).toBe(false)
    expect(
      thrown(
        Object.assign(new Error("400 boom"), {
          status: 400,
          headers: new Headers({ "x-should-retry": "true" }),
        }),
      ),
    ).toBe(true)
    // undici 的网络码挂在 cause 上，按 code 精确匹配
    expect(
      thrown(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })),
    ).toBe(true)
    expect(thrown(Object.assign(new Error("bad"), { code: "ERR_INVALID_ARG_TYPE" }))).toBe(false)
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
