/**
 * Responses 流 → 草稿：reasoning（两段 summary + 收尾带 encrypted_content）+ message + function_call 的完整流、
 * 无加密项的 reasoning、completed.output 回填加密项、用量换算与成本、各 status、response.failed / error 事件、
 * 缺终态事件、坏帧与未知字段、宿主中止与超时、pi 版事件可互换。
 */
import type { CoreEventDraft, LoweringDelta } from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import type { SseMessage } from "../sse.js"
import { consumeResponsesStream, usageOf } from "./from-stream.js"
import { reasoningItemOf } from "./to-request.js"

const origin = { provider: "openai", api: "openai-responses", model: "gpt-5-mini" }
const cost = { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 }

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

const created = {
  type: "response.created",
  response: { id: "resp_1", model: "gpt-5-mini-2025-08-07", status: "in_progress" },
}
const added = (output_index: number, item: Record<string, unknown>) => ({
  type: "response.output_item.added",
  output_index,
  item,
  p: "padding",
})
const done = (output_index: number, item: Record<string, unknown>) => ({
  type: "response.output_item.done",
  output_index,
  item,
})
const completed = (usage: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "response.completed",
  response: { id: "resp_1", model: "gpt-5-mini-2025-08-07", status: "completed", usage, ...extra },
})
const REASONING_DONE = {
  id: "rs_1",
  type: "reasoning",
  summary: [
    { type: "summary_text", text: "先查天气" },
    { type: "summary_text", text: "再作答" },
  ],
  encrypted_content: "gAAAA-enc",
}

describe("consumeResponsesStream", () => {
  it("reasoning（两段 summary，收尾带 encrypted_content）+ message + function_call → 三条草稿；outcome toolUse、用量与成本", async () => {
    const deltas: LoweringDelta[] = []
    const { drafts, outcome } = await collect(
      consumeResponsesStream(
        {
          messages: feed([
            created,
            added(0, { id: "rs_1", type: "reasoning", summary: [] }),
            { type: "response.reasoning_summary_part.added", output_index: 0, summary_index: 0 },
            { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "先查" },
            { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "天气" },
            { type: "response.reasoning_summary_part.done", output_index: 0 },
            { type: "response.reasoning_summary_part.added", output_index: 0, summary_index: 1 },
            { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "再作答" },
            done(0, REASONING_DONE),
            added(1, { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] }),
            { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "我来" },
            { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "查" },
            done(1, {
              id: "msg_1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "我来查", annotations: [] }],
              phase: "commentary",
            }),
            added(2, {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "get_weather",
              arguments: "",
            }),
            { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"city":' },
            { type: "response.function_call_arguments.delta", output_index: 2, delta: '"上海"}' },
            { type: "response.function_call_arguments.done", output_index: 2, arguments: '{"city":"上海"}' },
            done(2, {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "get_weather",
              arguments: '{"city":"上海"}',
              status: "completed",
            }),
            completed({
              input_tokens: 1000,
              input_tokens_details: { cached_tokens: 600 },
              output_tokens: 80,
              output_tokens_details: { reasoning_tokens: 50 },
              total_tokens: 1080,
            }),
          ]),
          origin,
          cost,
        },
        { onDelta: (d) => deltas.push(d) },
      ),
    )
    expect(drafts).toEqual([
      {
        type: "core.model_thinking",
        actor: "model",
        payload: { text: "先查天气\n\n再作答" },
        replay: { ...origin, thinkingSignature: JSON.stringify(REASONING_DONE) },
      },
      {
        type: "core.model_text",
        actor: "model",
        payload: { text: "我来查" },
        replay: { ...origin, textSignature: "msg_1", phase: "commentary" },
      },
      {
        type: "core.tool_call",
        actor: "model",
        payload: { toolCallId: "call_1", name: "get_weather", args: { city: "上海" } },
        replay: { ...origin, itemId: "fc_1" },
      },
    ])
    // 写侧能从签名里取回整项
    expect(reasoningItemOf(drafts[0]?.replay ?? {})).toEqual(REASONING_DONE)
    expect(deltas).toEqual([
      { kind: "thinking", index: 0, delta: "先查" },
      { kind: "thinking", index: 0, delta: "天气" },
      { kind: "thinking", index: 0, delta: "\n\n" },
      { kind: "thinking", index: 0, delta: "再作答" },
      { kind: "text", index: 1, delta: "我来" },
      { kind: "text", index: 1, delta: "查" },
      { kind: "tool_args", index: 2, delta: '{"city":' },
      { kind: "tool_args", index: 2, delta: '"上海"}' },
    ])
    expect(outcome).toMatchObject({
      stopReason: "toolUse",
      usage: { input: 400, output: 80, cacheRead: 600 },
      responseModel: "gpt-5-mini-2025-08-07",
    })
    expect((outcome as { costUsd: number }).costUsd).toBeCloseTo(
      (400 * 0.25 + 600 * 0.025 + 80 * 2) / 1e6,
      12,
    )
  })

  it("reasoning 没有 encrypted_content：有摘要就出草稿但不带签名（写侧 dropped）；既无加密项又无摘要的项不出草稿", async () => {
    const { drafts } = await collect(
      consumeResponsesStream({
        messages: feed([
          created,
          done(0, { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "想" }] }),
          done(1, { id: "rs_2", type: "reasoning", summary: [] }),
          done(2, {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "答", annotations: [] }],
          }),
          completed({ input_tokens: 10, output_tokens: 5 }),
        ]),
        origin,
      }),
    )
    expect(drafts.map((d) => d.type)).toEqual(["core.model_thinking", "core.model_text"])
    expect(drafts[0]?.replay).toEqual(origin)
    expect(reasoningItemOf(drafts[0]?.replay ?? {})).toBeUndefined()
  })

  it("有加密项、摘要为空的 reasoning 项也留草稿（正文空、签名在），下一轮必须回放；completed.output 里的 encrypted_content 回填到项上", async () => {
    const { drafts } = await collect(
      consumeResponsesStream({
        messages: feed([
          created,
          done(0, { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "gAAAA" }),
          done(1, { id: "rs_2", type: "reasoning", summary: [] }),
          completed(
            { input_tokens: 10, output_tokens: 5 },
            { output: [{ id: "rs_2", type: "reasoning", summary: [], encrypted_content: "gBBBB-late" }] },
          ),
        ]),
        origin,
      }),
    )
    expect(drafts).toHaveLength(2)
    expect(drafts[0]?.payload).toEqual({ text: "" })
    expect(reasoningItemOf(drafts[0]?.replay ?? {})?.encrypted_content).toBe("gAAAA")
    expect(reasoningItemOf(drafts[1]?.replay ?? {})?.encrypted_content).toBe("gBBBB-late")
  })

  it("usageOf：input 减掉 cached 与 cache_write，两者分别落 cacheRead / cacheWrite；缺字段按 0", () => {
    expect(
      usageOf({
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 300, cache_write_tokens: 200 },
        output_tokens: 7,
      }),
    ).toEqual({ input: 500, output: 7, cacheRead: 300, cacheWrite: 200 })
    expect(usageOf({ input_tokens: 5 })).toEqual({ input: 5, output: 0 })
    expect(usageOf(undefined)).toEqual({ input: 0, output: 0 })
  })

  it("status 映射：completed → stop；incomplete + max_output_tokens → length；incomplete + content_filter → error（不重试）；cancelled → error", async () => {
    const run = async (status: string, reason?: string) =>
      (
        await collect(
          consumeResponsesStream({
            messages: feed([
              created,
              done(0, {
                id: "msg_1",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "半截", annotations: [] }],
              }),
              {
                type: status === "completed" ? "response.completed" : "response.incomplete",
                response: {
                  id: "resp_1",
                  status,
                  ...(reason ? { incomplete_details: { reason } } : {}),
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              },
            ]),
            origin,
          }),
        )
      ).outcome as { stopReason: string; errorMessage?: string }
    expect((await run("completed")).stopReason).toBe("stop")
    expect((await run("incomplete", "max_output_tokens")).stopReason).toBe("length")
    const filtered = await run("incomplete", "content_filter")
    expect(filtered.stopReason).toBe("error")
    expect(filtered.errorMessage).toContain("content_filter")
    expect((await run("cancelled")).stopReason).toBe("error")
  })

  it("response.failed → error 带 code 与 message；流里的 error 事件立即收尾；半截正文仍交出", async () => {
    const failed = await collect(
      consumeResponsesStream({
        messages: feed([
          created,
          {
            type: "response.failed",
            response: {
              id: "resp_1",
              status: "failed",
              error: { code: "rate_limit_exceeded", message: "Rate limit reached" },
            },
          },
        ]),
        origin,
      }),
    )
    expect(failed.outcome).toMatchObject({
      stopReason: "error",
      errorMessage: "rate_limit_exceeded: Rate limit reached",
    })

    const errored = await collect(
      consumeResponsesStream({
        messages: feed([
          created,
          added(0, { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] }),
          { type: "response.output_text.delta", output_index: 0, delta: "半截" },
          { type: "error", code: "server_error", message: "boom" },
          done(0, {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "不该到这里", annotations: [] }],
          }),
        ]),
        origin,
      }),
    )
    expect(errored.drafts).toEqual([
      {
        type: "core.model_text",
        actor: "model",
        payload: { text: "半截" },
        replay: { ...origin, textSignature: "msg_1" },
      },
    ])
    expect(errored.outcome).toMatchObject({ stopReason: "error", errorMessage: "server_error: boom" })
  })

  it("没等到终态事件 → error 'stream ended before response.completed'（core 判可重试）；坏帧跳过；refusal 段并进正文", async () => {
    const { drafts, outcome } = await collect(
      consumeResponsesStream({
        messages: feed([
          created,
          "not json",
          added(0, { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] }),
          { type: "response.refusal.delta", output_index: 0, delta: "不能" },
          { type: "response.refusal.delta", output_index: 0, delta: "回答" },
        ]),
        origin,
      }),
    )
    expect(drafts).toEqual([
      {
        type: "core.model_text",
        actor: "model",
        payload: { text: "不能回答" },
        replay: { ...origin, textSignature: "msg_1" },
      },
    ])
    expect(outcome).toMatchObject({
      stopReason: "error",
      errorMessage: "stream ended before response.completed",
    })
  })

  it("读流中途异常：宿主中止 → aborted；本地超时 → error 带 timed out；其它 → error 原文；已拼的草稿都交出", async () => {
    const make = (signal?: AbortSignal, timedOut = false) => {
      async function* broken(): AsyncGenerator<SseMessage> {
        yield { data: JSON.stringify(created) }
        yield {
          data: JSON.stringify(
            added(0, { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] }),
          ),
        }
        yield { data: JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "部分" }) }
        throw new Error("socket hang up")
      }
      return consumeResponsesStream({
        messages: broken(),
        origin,
        ...(signal ? { signal } : {}),
        timedOut: () => timedOut,
        timeoutMs: 1234,
      })
    }
    const ac = new AbortController()
    ac.abort()
    const aborted = await collect(make(ac.signal))
    expect(aborted.drafts[0]?.payload).toEqual({ text: "部分" })
    expect(aborted.outcome).toMatchObject({ stopReason: "aborted", errorMessage: "aborted by host" })
    const timedOut = await collect(make(undefined, true))
    expect(timedOut.outcome).toMatchObject({ stopReason: "error" })
    expect((timedOut.outcome as { errorMessage: string }).errorMessage).toContain("timed out after 1234ms")
    const other = await collect(make())
    expect(other.outcome).toMatchObject({ stopReason: "error", errorMessage: "socket hang up" })
  })

  it("function_call 入参解析不了原样存字符串；output_item.done 没先 added 也能建项", async () => {
    const { drafts, outcome } = await collect(
      consumeResponsesStream({
        messages: feed([
          created,
          done(0, {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "f",
            arguments: "{not json",
          }),
          done(1, { id: "ws_1", type: "web_search_call", status: "completed" }),
          completed({ input_tokens: 1, output_tokens: 1 }),
        ]),
        origin,
      }),
    )
    expect(drafts).toEqual([
      {
        type: "core.tool_call",
        actor: "model",
        payload: { toolCallId: "call_1", name: "f", args: "{not json" },
        replay: { ...origin, itemId: "fc_1" },
      },
    ])
    expect(outcome).toMatchObject({ stopReason: "toolUse" })
  })
})
