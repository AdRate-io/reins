/**
 * FetchLowering 全链：假 fetch 截请求体、回放 SSE；鉴权头与端点；缺 key / auth:none；
 * 以及一条真跑 core runLoop 的集成用例（模型调工具 → 结果回传 → 作答），证明它能当 createAgent 的降级层。
 */
import {
  type CoreEventDraft,
  createCoreEvent,
  createCoreRegistry,
  defineTool,
  type Event,
  InMemoryEventLog,
  LoweringError,
  type RunResult,
  runLoop,
} from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import { HttpError } from "./http.js"
import { FetchLowering } from "./lowering.js"

const registry = createCoreRegistry()
const MODEL = { provider: "deepseek", id: "deepseek-flash" }

function sse(chunks: unknown[]): string {
  return `${chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`
}
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
  object: "chat.completion.chunk",
  model: "deepseek-flash",
  choices: [{ index: 0, delta: d, finish_reason: finish }],
})
const usage = (prompt: number, completion: number) => ({
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion },
})

/** 按调用顺序回放预设响应的假 fetch，并截获每次请求 */
function fakeFetch(responses: (string | Response)[]) {
  const captured: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = []
  let i = 0
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    captured.push({ url: String(input), body: JSON.parse(String(init?.body)), headers })
    const r = responses[i++]
    if (r === undefined) throw new Error("fake fetch: no more responses")
    return typeof r === "string"
      ? new Response(r, { status: 200, headers: { "content-type": "text/event-stream" } })
      : r
  }) as typeof globalThis.fetch
  return { fetch, captured }
}

async function collect(gen: AsyncGenerator<CoreEventDraft, unknown>) {
  const drafts: CoreEventDraft[] = []
  let r = await gen.next()
  while (!r.done) {
    drafts.push(r.value)
    r = await gen.next()
  }
  return { drafts, outcome: r.value }
}

let seq = 0
const user = (text: string): Event =>
  createCoreEvent(registry, {
    type: "core.user_message",
    actor: "user",
    payload: { content: [{ type: "text", text }] },
    sessionId: "s",
    seq: ++seq,
    at: seq,
    id: `e${seq}`,
  })

describe("FetchLowering", () => {
  it("toRequest 的 payload.body 就是发出去的请求体；stream 加 Bearer 头打到 /chat/completions，草稿与 outcome 正确", async () => {
    const { fetch, captured } = fakeFetch([
      sse([delta({ role: "assistant", content: "你好" }, "stop"), usage(12, 3)]),
    ])
    const lowering = new FetchLowering({
      apiKey: (p) => (p === "deepseek" ? "sk-test" : undefined),
      fetch,
      headers: { "x-trace": "t1" },
      requestOptions: () => ({ max_tokens: 50 }),
    })
    const req = lowering.toRequest({ events: [user("hi")], model: MODEL, systemPrompt: "简短" })
    expect(req.payload.api).toBe("openai-chat")
    expect(req.payload.body).toEqual({
      max_tokens: 50,
      model: "deepseek-flash",
      messages: [
        { role: "system", content: "简短" },
        { role: "user", content: "hi" },
      ],
      stream: true,
      stream_options: { include_usage: true },
    })
    const { drafts, outcome } = await collect(lowering.stream(req))
    expect(captured[0]?.url).toBe("https://api.deepseek.com/chat/completions")
    expect(captured[0]?.headers).toMatchObject({
      authorization: "Bearer sk-test",
      "x-trace": "t1",
      "content-type": "application/json",
    })
    expect(captured[0]?.body).toEqual(req.payload.body)
    expect(drafts).toEqual([
      {
        type: "core.model_text",
        actor: "model",
        payload: { text: "你好" },
        replay: { provider: "deepseek", api: "openai-chat", model: "deepseek-flash" },
      },
    ])
    expect(outcome).toMatchObject({
      stopReason: "stop",
      usage: { input: 12, output: 3 },
      responseModel: "deepseek-flash",
    })
    expect((outcome as { costUsd: number }).costUsd).toBeGreaterThan(0)
  })

  it('缺 key 抛 LoweringError(missing_api_key)（不重试）；auth:"none" 的模型不要 key、凭证走 headers', async () => {
    const { fetch, captured } = fakeFetch([sse([delta({ content: "ok" }, "stop")])])
    const lowering = new FetchLowering({
      apiKey: () => undefined,
      fetch,
      models: [
        {
          provider: "cf",
          id: "gpt-4o-mini",
          api: "openai-chat",
          baseUrl: "https://gateway.ai.cloudflare.com/v1/acc/gw/openai/v1",
          contextWindow: 128_000,
          maxOutputTokens: 16_384,
          reasoning: false,
          auth: "none",
          headers: { "cf-aig-authorization": "Bearer cfut_x" },
        },
      ],
    })
    const req = lowering.toRequest({ events: [user("hi")], model: MODEL })
    await expect(collect(lowering.stream(req))).rejects.toBeInstanceOf(LoweringError)
    const cfReq = lowering.toRequest({ events: [user("hi")], model: { provider: "cf", id: "gpt-4o-mini" } })
    await collect(lowering.stream(cfReq))
    expect(captured[0]?.url).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/openai/v1/chat/completions")
    expect(captured[0]?.headers.authorization).toBeUndefined()
    expect(captured[0]?.headers["cf-aig-authorization"]).toBe("Bearer cfut_x")
  })

  it("非 2xx 抛 HttpError，正文原文透传（网关信封也照样）", async () => {
    const { fetch } = fakeFetch([
      new Response('{"success":false,"error":[{"code":2018,"message":"Wholesale Rate limited"}]}', {
        status: 429,
      }),
    ])
    const lowering = new FetchLowering({ apiKey: () => "k", fetch })
    const req = lowering.toRequest({ events: [user("hi")], model: MODEL })
    const err = await collect(lowering.stream(req)).catch((e) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(429)
    expect((err as HttpError).message).toContain("Wholesale Rate limited")
  })

  it("找不到的模型 / 未实现的协议在 toRequest 就抛", () => {
    const lowering = new FetchLowering({
      apiKey: () => "k",
      models: [
        {
          provider: "anthropic",
          id: "claude-opus-5",
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com/v1",
          contextWindow: 1,
          maxOutputTokens: 1,
          reasoning: true,
        },
      ],
    })
    expect(() => lowering.toRequest({ events: [], model: { provider: "nobody", id: "x" } })).toThrow(
      /unsupported_model/,
    )
    expect(() =>
      lowering.toRequest({ events: [], model: { provider: "anthropic", id: "claude-opus-5" } }),
    ).toThrow(/unsupported_api/)
  })

  it("集成：core runLoop 上跑一条带工具的多轮——模型调 add → 结果以 tool 角色回传（带 reasoning_content）→ 模型作答", async () => {
    const { fetch, captured } = fakeFetch([
      sse([
        delta({ role: "assistant", content: null, reasoning_content: "要算加法" }),
        delta({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "add", arguments: '{"a":2,"b":3}' },
            },
          ],
        }),
        delta({}, "tool_calls"),
        usage(20, 8),
      ]),
      sse([delta({ role: "assistant", content: "等于 5", reasoning_content: "" }, "stop"), usage(40, 4)]),
    ])
    const lowering = new FetchLowering({ apiKey: () => "k", fetch })
    const add = defineTool<{ a: number; b: number }>({
      name: "add",
      description: "两数相加",
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
      execute: ({ a, b }) => a + b,
    })
    const log = new InMemoryEventLog()
    let t = 1_800_000_000_000
    let n = 0
    const gen = runLoop({
      sessionId: "s1",
      log,
      lowering,
      model: MODEL,
      tools: [add],
      input: "2+3 等于几？",
      systemPrompt: "你会算数",
      now: () => ++t,
      newId: () => `id${++n}`,
    })
    const events: Event[] = []
    let result: RunResult | undefined
    while (true) {
      const step = await gen.next()
      if (step.done) {
        result = step.value
        break
      }
      events.push(step.value)
    }
    expect(result?.status).toBe("done")
    expect(events.map((e) => e.type.replace("core.", ""))).toEqual([
      "tools_bound",
      "user_message",
      "model_thinking",
      "tool_call",
      "tool_result",
      "budget_usage",
      "model_text",
      "budget_usage",
    ])
    // 第二个请求：历史里的 assistant 带 tool_calls 与回填的 reasoning_content，tool 消息紧跟，工具结果包了 untrusted 标记
    const second = captured[1]?.body.messages as Record<string, unknown>[]
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"])
    expect(second[2]).toMatchObject({
      reasoning_content: "要算加法",
      tool_calls: [{ id: "call_1", function: { name: "add", arguments: '{"a":2,"b":3}' } }],
    })
    expect(second[3]).toMatchObject({ role: "tool", tool_call_id: "call_1" })
    expect(String(second[3]?.content)).toContain("5")
    expect(String(second[3]?.content)).toContain('<untrusted source="tool:add">')
    expect(captured[1]?.body.tools).toHaveLength(1)
  })
})
