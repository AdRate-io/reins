/**
 * Chat 流 → 草稿：DeepSeek 形状（reasoning_content + 分片 tool_calls + 末尾 usage）、OpenAI 形状（usage 单独一帧、choices 为空）、
 * finish_reason 各值、缺 [DONE]、坏 JSON 帧、宿主中止与超时的收尾。
 */
import type { CoreEventDraft, LoweringDelta } from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import type { SseMessage } from "../sse.js"
import { consumeChatStream, usageOf } from "./from-stream.js"

const origin = { provider: "deepseek", api: "openai-chat", model: "deepseek-flash" }
const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): SseMessage => ({
  data: JSON.stringify({
    id: "x",
    object: "chat.completion.chunk",
    model: "deepseek-flash",
    choices: [{ index: 0, delta, logprobs: null, finish_reason: null, ...extra }],
    usage: null,
    p: "padding-from-gateway",
  }),
})
const finish = (reason: string, usage?: Record<string, unknown>) =>
  chunk({}, { finish_reason: reason, ...(usage ? { __usage: usage } : {}) })

async function* iter(msgs: SseMessage[], opts: { throwAfter?: number; error?: unknown } = {}) {
  let i = 0
  for (const m of msgs) {
    if (opts.throwAfter !== undefined && i === opts.throwAfter) throw opts.error ?? new Error("terminated")
    i++
    yield m
  }
}

async function run(msgs: SseMessage[], extra: Partial<Parameters<typeof consumeChatStream>[0]> = {}) {
  const drafts: CoreEventDraft[] = []
  const deltas: LoweringDelta[] = []
  const gen = consumeChatStream(
    { messages: iter(msgs), origin, ...extra },
    { onDelta: (d) => deltas.push(d) },
  )
  let r = await gen.next()
  while (!r.done) {
    drafts.push(r.value)
    r = await gen.next()
  }
  return { drafts, deltas, outcome: r.value }
}

describe("consumeChatStream", () => {
  it("DeepSeek 形状：reasoning_content → thinking，content → text，分片 tool_calls 按 index 拼 JSON；末帧 usage 换算成 core 形状并算钱", async () => {
    const usageChunk: SseMessage = {
      data: JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          prompt_tokens_details: { cached_tokens: 60 },
          prompt_cache_hit_tokens: 60,
          prompt_cache_miss_tokens: 40,
          completion_tokens_details: { reasoning_tokens: 10 },
        },
      }),
    }
    const { drafts, deltas, outcome } = await run(
      [
        chunk({ role: "assistant", content: null, reasoning_content: "" }),
        chunk({ content: null, reasoning_content: "先查" }),
        chunk({ content: null, reasoning_content: "天气" }),
        chunk({ content: "好的" }),
        chunk({
          tool_calls: [
            { index: 0, id: "call_a", type: "function", function: { name: "get_weather", arguments: "" } },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
        chunk({
          tool_calls: [
            {
              index: 1,
              id: "call_b",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"北京"}' },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"上海"}' } }] }),
        finish("tool_calls"),
        usageChunk,
        { data: "[DONE]" },
      ],
      { cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } },
    )
    expect(drafts).toEqual([
      { type: "core.model_thinking", actor: "model", payload: { text: "先查天气" }, replay: origin },
      { type: "core.model_text", actor: "model", payload: { text: "好的" }, replay: origin },
      {
        type: "core.tool_call",
        actor: "model",
        payload: { toolCallId: "call_a", name: "get_weather", args: { city: "上海" } },
        replay: origin,
      },
      {
        type: "core.tool_call",
        actor: "model",
        payload: { toolCallId: "call_b", name: "get_weather", args: { city: "北京" } },
        replay: origin,
      },
    ])
    // 块序号按首次出现分配：thinking 0、text 1、tool 0 → 2、tool 1 → 3
    expect(deltas.map((d) => `${d.kind}:${d.index}`)).toEqual([
      "thinking:0",
      "thinking:0",
      "text:1",
      "tool_args:2",
      "tool_args:3",
      "tool_args:2",
    ])
    expect(outcome).toMatchObject({
      stopReason: "toolUse",
      usage: { input: 40, output: 40, cacheRead: 60 },
      responseModel: "deepseek-flash",
    })
    expect(outcome.costUsd).toBeCloseTo((40 * 1 + 40 * 2 + 60 * 0.5) / 1_000_000, 12)
  })

  it("OpenAI 形状：finish_reason=stop、usage 单独一帧、无 reasoning；空 content 不产文本草稿", async () => {
    const { drafts, outcome } = await run([
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Hi" }),
      finish("stop"),
      { data: JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }) },
      { data: "[DONE]" },
    ])
    expect(drafts).toEqual([
      { type: "core.model_text", actor: "model", payload: { text: "Hi" }, replay: origin },
    ])
    expect(outcome).toMatchObject({ stopReason: "stop", usage: { input: 10, output: 1 } })
    expect(outcome.costUsd).toBeUndefined()
  })

  it("强制 tool_choice 时官方 finish_reason 是 stop：有 tool_call 就判 toolUse", async () => {
    const { outcome } = await run([
      chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: "{}" } }] }),
      finish("stop"),
      { data: "[DONE]" },
    ])
    expect(outcome.stopReason).toBe("toolUse")
  })

  it("length → length；content_filter / insufficient_system_resource / aborted → error 且文案带原因", async () => {
    expect(
      (await run([chunk({ content: "a" }), finish("length"), { data: "[DONE]" }])).outcome.stopReason,
    ).toBe("length")
    const filtered = (await run([chunk({ content: "a" }), finish("content_filter"), { data: "[DONE]" }]))
      .outcome
    expect(filtered.stopReason).toBe("error")
    expect(filtered.errorMessage).toContain("content_filter")
    const busy = (await run([finish("insufficient_system_resource"), { data: "[DONE]" }])).outcome
    expect(busy.errorMessage).toContain("temporarily unavailable")
    expect((await run([finish("aborted"), { data: "[DONE]" }])).outcome.stopReason).toBe("error")
  })

  it("没有 [DONE] 也没有 finish_reason：已拼出的内容照样交出去，outcome 记 error（core 判可重试）", async () => {
    const { drafts, outcome } = await run([chunk({ content: "半" }), chunk({ content: "截" })])
    expect(drafts).toEqual([
      { type: "core.model_text", actor: "model", payload: { text: "半截" }, replay: origin },
    ])
    expect(outcome.stopReason).toBe("error")
    expect(outcome.errorMessage).toBe("stream ended before finish_reason")
  })

  it("有 [DONE] 但网关吞了 finish_reason：有正文按 stop 收尾", async () => {
    const { outcome } = await run([chunk({ content: "ok" }), { data: "[DONE]" }])
    expect(outcome.stopReason).toBe("stop")
  })

  it("坏 JSON 帧跳过，不让整条流作废", async () => {
    const { drafts } = await run([
      { data: "{oops" },
      chunk({ content: "ok" }),
      finish("stop"),
      { data: "[DONE]" },
    ])
    expect(drafts).toHaveLength(1)
  })

  it("入参 JSON 解析失败：args 存原始字符串；空入参 → {}", async () => {
    const { drafts } = await run([
      chunk({
        tool_calls: [
          { index: 0, id: "a", function: { name: "f", arguments: "{broken" } },
          { index: 1, id: "b", function: { name: "g", arguments: "" } },
        ],
      }),
      finish("tool_calls"),
      { data: "[DONE]" },
    ])
    expect(drafts.map((d) => (d.type === "core.tool_call" ? d.payload.args : null))).toEqual(["{broken", {}])
  })

  it("读流中途出错：先交出部分草稿，宿主中止判 aborted、超时判 error(timed out)、其它按错误文案（带 cause.code）", async () => {
    const msgs = [chunk({ content: "半" }), chunk({ content: "截" }), finish("stop")]
    // 宿主中止：fetch 的流读取会以 AbortError 拒绝，这里用抛错模拟
    const aborted = new AbortController()
    aborted.abort()
    const a = await consume(
      iter(msgs, { throwAfter: 1, error: new DOMException("The operation was aborted.", "AbortError") }),
      { signal: aborted.signal },
    )
    expect(a.outcome.stopReason).toBe("aborted")
    expect(a.drafts).toHaveLength(1)

    const t = await consume(iter(msgs, { throwAfter: 1 }), { timedOut: () => true, timeoutMs: 5 })
    expect(t.outcome.stopReason).toBe("error")
    expect(t.outcome.errorMessage).toContain("timed out after 5ms")
    expect(t.drafts).toEqual([
      { type: "core.model_text", actor: "model", payload: { text: "半" }, replay: origin },
    ])

    const net = await consume(
      iter(msgs, {
        throwAfter: 1,
        error: Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }),
      }),
      {},
    )
    expect(net.outcome).toMatchObject({ stopReason: "error", errorMessage: "fetch failed (ECONNRESET)" })
  })
})

async function consume(
  messages: AsyncIterable<SseMessage>,
  extra: Partial<Parameters<typeof consumeChatStream>[0]>,
) {
  const drafts: CoreEventDraft[] = []
  const gen = consumeChatStream({ messages, origin, ...extra })
  let r = await gen.next()
  while (!r.done) {
    drafts.push(r.value)
    r = await gen.next()
  }
  return { drafts, outcome: r.value }
}

describe("usageOf", () => {
  it("input 是未命中数（prompt − cached）；cached 为 0 不写 cacheRead；DeepSeek 原生字段兜底", () => {
    expect(usageOf({ prompt_tokens: 10, completion_tokens: 2 })).toEqual({ input: 10, output: 2 })
    expect(usageOf({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 })).toEqual({
      input: 6,
      output: 2,
      cacheRead: 4,
    })
    expect(usageOf(undefined)).toEqual({ input: 0, output: 0 })
  })
})
