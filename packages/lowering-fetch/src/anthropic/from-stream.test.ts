/**
 * Anthropic 流 → 草稿：thinking + signature + text + tool_use 的完整流、redacted、空正文 thinking（display omitted）、
 * 用量换算与成本、各 stop_reason、error 事件、缺 message_stop、坏帧与未知字段、宿主中止与超时。
 */
import type { CoreEventDraft, LoweringDelta } from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import type { SseMessage } from "../sse.js"
import { consumeAnthropicStream, REDACTED_THINKING_TEXT, usageOf } from "./from-stream.js"

const origin = { provider: "anthropic", api: "anthropic-messages", model: "claude-opus-5" }
const cost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }

async function* feed(events: (unknown | string)[]): AsyncGenerator<SseMessage> {
  for (const e of events) yield { data: typeof e === "string" ? e : JSON.stringify(e) }
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

const start = (usage: Record<string, number> = { input_tokens: 100, output_tokens: 1 }) => ({
  type: "message_start",
  message: { id: "msg_1", type: "message", model: "claude-opus-5-20260301", usage },
  p: "padding-from-anthropic",
})
const bstart = (index: number, content_block: Record<string, unknown>) => ({
  type: "content_block_start",
  index,
  content_block,
})
const bdelta = (index: number, delta: Record<string, unknown>) => ({
  type: "content_block_delta",
  index,
  delta,
})
const bstop = (index: number) => ({ type: "content_block_stop", index })
const mdelta = (stop_reason: string, output_tokens: number, extra: Record<string, unknown> = {}) => ({
  type: "message_delta",
  delta: { stop_reason, stop_sequence: null, ...extra },
  usage: { output_tokens },
})
const mstop = { type: "message_stop" }

describe("consumeAnthropicStream", () => {
  it("thinking（signature_delta）+ text + tool_use（input_json_delta）→ 三条草稿，replay 带签名与来源；outcome toolUse、用量与成本", async () => {
    const deltas: LoweringDelta[] = []
    const { drafts, outcome } = await collect(
      consumeAnthropicStream(
        {
          messages: feed([
            start({
              input_tokens: 40,
              cache_creation_input_tokens: 60,
              cache_read_input_tokens: 900,
              output_tokens: 2,
            }),
            { type: "ping" },
            bstart(0, { type: "thinking", thinking: "" }),
            bdelta(0, { type: "thinking_delta", thinking: "看看" }),
            bdelta(0, { type: "thinking_delta", thinking: "天气" }),
            bdelta(0, { type: "signature_delta", signature: "SIG" }),
            bstop(0),
            bstart(1, { type: "text", text: "" }),
            bdelta(1, { type: "text_delta", text: "查一下" }),
            bstop(1),
            bstart(2, { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} }),
            bdelta(2, { type: "input_json_delta", partial_json: '{"city":' }),
            bdelta(2, { type: "input_json_delta", partial_json: '"Shanghai"}' }),
            bstop(2),
            mdelta("tool_use", 33),
            mstop,
          ]),
          origin,
          cost,
        },
        { onDelta: (d) => deltas.push(d) },
      ),
    )
    const replay = { ...origin }
    expect(drafts).toEqual([
      {
        type: "core.model_thinking",
        actor: "model",
        payload: { text: "看看天气" },
        replay: { ...replay, thinkingSignature: "SIG" },
      },
      { type: "core.model_text", actor: "model", payload: { text: "查一下" }, replay },
      {
        type: "core.tool_call",
        actor: "model",
        payload: { toolCallId: "toolu_1", name: "get_weather", args: { city: "Shanghai" } },
        replay,
      },
    ])
    expect(outcome).toEqual({
      stopReason: "toolUse",
      usage: { input: 40, output: 33, cacheRead: 900, cacheWrite: 60 },
      costUsd: (40 * 5 + 33 * 25 + 900 * 0.5 + 60 * 6.25) / 1_000_000,
      responseModel: "claude-opus-5-20260301",
    })
    expect(deltas).toEqual([
      { kind: "thinking", index: 0, delta: "看看" },
      { kind: "thinking", index: 0, delta: "天气" },
      { kind: "text", index: 1, delta: "查一下" },
      { kind: "tool_args", index: 2, delta: '{"city":' },
      { kind: "tool_args", index: 2, delta: '"Shanghai"}' },
    ])
  })

  it("正文为空但有签名的 thinking（display omitted）仍出草稿；redacted_thinking 出 pi-ai 同款草稿；空 text 块不出", async () => {
    const { drafts, outcome } = await collect(
      consumeAnthropicStream({
        messages: feed([
          start(),
          bstart(0, { type: "thinking", thinking: "", signature: "" }),
          bdelta(0, { type: "signature_delta", signature: "S1" }),
          bstop(0),
          bstart(1, { type: "redacted_thinking", data: "OPAQUE" }),
          bstop(1),
          bstart(2, { type: "text", text: "" }),
          bstop(2),
          bstart(3, { type: "text", text: "" }),
          bdelta(3, { type: "text_delta", text: "hi" }),
          bstop(3),
          mdelta("end_turn", 5),
          mstop,
        ]),
        origin,
      }),
    )
    expect(drafts.map((d) => d.type)).toEqual([
      "core.model_thinking",
      "core.model_thinking",
      "core.model_text",
    ])
    expect(drafts[0]).toMatchObject({ payload: { text: "" }, replay: { thinkingSignature: "S1" } })
    expect(drafts[1]).toMatchObject({
      payload: { text: REDACTED_THINKING_TEXT },
      replay: { thinkingSignature: "OPAQUE", redacted: true },
    })
    expect(outcome).toMatchObject({ stopReason: "stop", usage: { input: 100, output: 5 } })
  })

  it("tool_use 没有 input_json_delta 时用 content_block_start 的 input；坏 JSON 原样存字符串", async () => {
    const { drafts } = await collect(
      consumeAnthropicStream({
        messages: feed([
          start(),
          bstart(0, { type: "tool_use", id: "t1", name: "f", input: { a: 1 } }),
          bstop(0),
          bstart(1, { type: "tool_use", id: "t2", name: "g", input: {} }),
          bdelta(1, { type: "input_json_delta", partial_json: '{"broken' }),
          bstop(1),
          mdelta("tool_use", 3),
          mstop,
        ]),
        origin,
      }),
    )
    expect(drafts[0]).toMatchObject({ payload: { toolCallId: "t1", args: { a: 1 } } })
    expect(drafts[1]).toMatchObject({ payload: { toolCallId: "t2", args: '{"broken' } })
  })

  it("stop_reason 映射：max_tokens / model_context_window_exceeded → length；refusal → error 带 stop_details；pause_turn → stop", async () => {
    const run = (reason: string, extra: Record<string, unknown> = {}) =>
      collect(consumeAnthropicStream({ messages: feed([start(), mdelta(reason, 1, extra), mstop]), origin }))
    expect((await run("max_tokens")).outcome).toMatchObject({ stopReason: "length" })
    expect((await run("model_context_window_exceeded")).outcome).toMatchObject({ stopReason: "length" })
    expect((await run("pause_turn")).outcome).toMatchObject({ stopReason: "stop" })
    const refusal = (
      await run("refusal", {
        stop_details: { type: "refusal", category: "reasoning_extraction", explanation: "nope" },
      })
    ).outcome
    expect(refusal).toMatchObject({ stopReason: "error" })
    expect(String((refusal as { errorMessage: string }).errorMessage)).toContain("reasoning_extraction")
    expect(String((refusal as { errorMessage: string }).errorMessage)).toContain("nope")
  })

  it("流里的 error 事件 → error（overloaded 文案保留给 core 判瞬断）；缺 message_stop → error；坏帧跳过", async () => {
    const err = await collect(
      consumeAnthropicStream({
        messages: feed([
          start(),
          bstart(0, { type: "text", text: "" }),
          bdelta(0, { type: "text_delta", text: "半截" }),
          { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
        ]),
        origin,
      }),
    )
    expect(err.drafts).toEqual([
      { type: "core.model_text", actor: "model", payload: { text: "半截" }, replay: origin },
    ])
    expect(err.outcome).toMatchObject({ stopReason: "error", errorMessage: "overloaded_error: Overloaded" })

    const cut = await collect(
      consumeAnthropicStream({
        messages: feed([start(), "not json", bstart(0, { type: "text", text: "" })]),
        origin,
      }),
    )
    expect(cut.outcome).toMatchObject({
      stopReason: "error",
      errorMessage: "stream ended before message_stop",
    })
  })

  it("读流中途出错：宿主中止 → aborted；本地超时 → error（timed out）；其它 → error 带文案，已拼草稿先交出", async () => {
    async function* broken(): AsyncGenerator<SseMessage> {
      yield { data: JSON.stringify(start()) }
      yield { data: JSON.stringify(bstart(0, { type: "text", text: "" })) }
      yield { data: JSON.stringify(bdelta(0, { type: "text_delta", text: "部分" })) }
      throw Object.assign(new Error("terminated"), { cause: { code: "UND_ERR_SOCKET" } })
    }
    const ac = new AbortController()
    ac.abort()
    const aborted = await collect(consumeAnthropicStream({ messages: broken(), origin, signal: ac.signal }))
    expect(aborted.drafts).toHaveLength(1)
    expect(aborted.outcome).toMatchObject({ stopReason: "aborted" })

    const timed = await collect(
      consumeAnthropicStream({ messages: broken(), origin, timedOut: () => true, timeoutMs: 7 }),
    )
    expect(timed.outcome).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("timed out after 7ms"),
    })

    const other = await collect(consumeAnthropicStream({ messages: broken(), origin }))
    expect(other.outcome).toMatchObject({ stopReason: "error", errorMessage: "terminated (UND_ERR_SOCKET)" })
  })

  it("usageOf：input 就是未命中数（厂商语义与 core 一致）；message_delta 后到的字段覆盖 message_start", () => {
    expect(
      usageOf({ input_tokens: 10, cache_read_input_tokens: 0 }, { output_tokens: 3, input_tokens: 12 }),
    ).toEqual({
      input: 12,
      output: 3,
    })
    expect(usageOf(undefined, undefined)).toEqual({ input: 0, output: 0 })
  })
})
