/**
 * fetch 封装与 core 瞬断判据的对接：非 2xx 抛 HttpError（"<status> <body>" 格式、带 status / headers），
 * core 的 isTransientFailure 据此判 429 / 5xx 可重试、400 不可；超时判可重试、宿主中止不重试。
 */
import { isTransientFailure } from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import { HttpError, postJson, requestSignals } from "./http.js"
import { parseSse } from "./sse.js"

const respond = (status: number, body: string, headers: Record<string, string> = {}) =>
  (async () => new Response(body, { status, headers })) as typeof globalThis.fetch

async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (e) {
    return e
  }
  throw new Error("expected to throw")
}

describe("postJson", () => {
  it('非 2xx → HttpError，文案是 SDK 同款 "<status> <body>"，带 status / headers / url', async () => {
    const err = (await thrown(() =>
      postJson({
        url: "https://x/v1/chat/completions",
        headers: {},
        body: {},
        signal: new AbortController().signal,
        fetch: respond(429, '{"error":"slow down"}', { "retry-after": "2" }),
      }),
    )) as HttpError
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(429)
    expect(err.message).toBe('429 {"error":"slow down"}')
    expect(err.headers.get("retry-after")).toBe("2")
    expect(err.url).toBe("https://x/v1/chat/completions")
  })

  it("core 的瞬断判据：429 / 503 重试，400 不重试（即使正文写着 timeout / 429）", async () => {
    const h = new Headers()
    const judge = (status: number, body: string) =>
      isTransientFailure({ kind: "thrown", error: new HttpError(status, h, body, "u") })
    expect(judge(429, "rate limited")).toBe(true)
    expect(judge(503, "overloaded")).toBe(true)
    expect(judge(500, "")).toBe(true)
    expect(judge(400, "request timeout: field 429 invalid")).toBe(false)
    expect(judge(401, "Missing bearer")).toBe(false)
  })

  it("2xx 但正文是 JSON（网关把错误以 200 + JSON 回）：读出原文抛 HttpError，不交给 SSE 解析吞掉；不判瞬断（全库审查 #72）", async () => {
    const err = (await thrown(() =>
      postJson({
        url: "u",
        headers: {},
        body: {},
        signal: new AbortController().signal,
        fetch: respond(200, '{"error":{"message":"invalid api key"}}', {
          "content-type": "application/json",
        }),
      }),
    )) as HttpError
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(200)
    expect(err.message).toContain("invalid api key")
    expect(isTransientFailure({ kind: "thrown", error: err })).toBe(false)
    // 正常的 SSE 与没写 content-type 的响应照旧交给流解析
    const ok = await postJson({
      url: "u",
      headers: {},
      body: {},
      signal: new AbortController().signal,
      fetch: respond(200, "data: {}\n\n", { "content-type": "text/event-stream; charset=utf-8" }),
    })
    expect(ok.status).toBe(200)
  })

  it("2xx 标成 JSON、正文却是 SSE（中转站标错类型）：分块到达也逐帧交回流解析，不抛（审查返修）", async () => {
    const enc = new TextEncoder()
    // 第一块只有前导空白与半个字段名，判定要跨块攒；后面的块在偷看之后才读
    const chunks = ["\nda", 'ta: {"a":1}\n\n', ": keep-alive\n\n", "data: [DONE]\n\n"]
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of chunks) c.enqueue(enc.encode(s))
        c.close()
      },
    })
    const res = await postJson({
      url: "u",
      headers: {},
      body: {},
      signal: new AbortController().signal,
      fetch: (async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    })
    const messages: string[] = []
    for await (const m of parseSse(res.body as ReadableStream<Uint8Array>)) messages.push(m.data)
    expect(messages).toEqual(['{"a":1}', "[DONE]"])
    // 带 BOM 的 JSON 错误体、只有空白的正文照样抛
    for (const text of ['﻿  {"error":"quota"}', "  "]) {
      const err = (await thrown(() =>
        postJson({
          url: "u",
          headers: {},
          body: {},
          signal: new AbortController().signal,
          fetch: respond(200, text, { "content-type": "application/json; charset=utf-8" }),
        }),
      )) as HttpError
      expect(err).toBeInstanceOf(HttpError)
      expect(err.message).toBe(`200 ${text.replace(/^\uFEFF/, "")}`)
    }
  })

  it("服务端 x-should-retry 头优先于状态码", () => {
    const err = new HttpError(400, new Headers({ "x-should-retry": "true" }), "odd", "u")
    expect(isTransientFailure({ kind: "thrown", error: err })).toBe(true)
  })

  it("发请求时带 content-type / accept，宿主头覆盖缺省", async () => {
    let seen: Headers | undefined
    const fetch = (async (_: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers)
      return new Response("", { status: 200 })
    }) as typeof globalThis.fetch
    await postJson({
      url: "u",
      headers: { authorization: "Bearer k", accept: "*/*" },
      body: { a: 1 },
      signal: new AbortController().signal,
      fetch,
    })
    expect(seen?.get("content-type")).toBe("application/json")
    expect(seen?.get("accept")).toBe("*/*")
    expect(seen?.get("authorization")).toBe("Bearer k")
  })
})

describe("requestSignals", () => {
  it("超时触发：signal 中止、timedOut 为真；超时错误 core 判可重试", async () => {
    const s = requestSignals(undefined, 5)
    await new Promise((r) => setTimeout(r, 30))
    expect(s.signal.aborted).toBe(true)
    expect(s.timedOut()).toBe(true)
    // fetch 因超时信号中止时抛的就是这个 reason（DOMException TimeoutError）
    expect(isTransientFailure({ kind: "thrown", error: s.signal.reason })).toBe(true)
  })

  it("touch 重新计空档：持续 touch 的总时长超过时限也不中止；dispose 后不再中止（全库审查 #27）", async () => {
    const s = requestSignals(undefined, 40)
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 15))
      s.touch()
    }
    expect(s.signal.aborted).toBe(false)
    s.dispose()
    await new Promise((r) => setTimeout(r, 60))
    expect(s.signal.aborted).toBe(false)
    expect(s.timedOut()).toBe(false)
  })

  it("宿主中止优先：两者都发生时 timedOut 为假；AbortError 不重试", async () => {
    const host = new AbortController()
    const s = requestSignals(host.signal, 5)
    host.abort()
    await new Promise((r) => setTimeout(r, 30))
    expect(s.signal.aborted).toBe(true)
    expect(s.timedOut()).toBe(false)
    expect(isTransientFailure({ kind: "thrown", error: s.signal.reason })).toBe(false)
  })
})
