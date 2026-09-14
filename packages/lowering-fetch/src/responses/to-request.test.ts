/**
 * IR → Responses 请求体：store:false 强制与 previous_response_id 剥掉、include 加密项、developer / system 角色、
 * reasoning 项回放判据、正文项 id 的三种来源、function_call 的两个 id、function_call_output 的三种形态、说明任意位置。
 */
import {
  type CoreEventPayloads,
  type CoreEventType,
  createCoreEvent,
  createCoreRegistry,
  type Event,
} from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import { capabilitiesOf } from "../capabilities.js"
import { eventsToIr } from "../ir.js"
import type { FetchModel } from "../models.js"
import { encodeResponsesRequest, type ResponsesInputContent, type ResponsesInputItem } from "./to-request.js"

const registry = createCoreRegistry()
let seq = 0
const ev = <T extends CoreEventType>(
  type: T,
  actor: Event["actor"],
  payload: CoreEventPayloads[T],
  extra: { replay?: Record<string, unknown>; trust?: Event["trust"] } = {},
): Event =>
  createCoreEvent(registry, {
    type,
    actor,
    payload,
    sessionId: "s",
    seq: ++seq,
    at: 1000 + seq,
    id: `e${seq}`,
    ...extra,
  })

const mini: FetchModel = {
  provider: "openai",
  id: "gpt-5-mini",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 400_000,
  maxOutputTokens: 128_000,
  reasoning: true,
  images: true,
}
const gpt41: FetchModel = { ...mini, id: "gpt-4.1", reasoning: false, images: false }
const origin = { provider: "openai", api: "openai-responses", model: "gpt-5-mini" }
const reasoningItem = {
  id: "rs_1",
  type: "reasoning",
  summary: [{ type: "summary_text", text: "想一下" }],
  encrypted_content: "gAAAA-real",
}

const user = (text: string) => ev("core.user_message", "user", { content: [{ type: "text", text }] })
const text = (t: string, replay: Record<string, unknown> = origin) =>
  ev("core.model_text", "model", { text: t }, { replay })
const thinking = (t: string, replay: Record<string, unknown>) =>
  ev("core.model_thinking", "model", { text: t }, { replay })
const call = (id: string, args: unknown = { q: 1 }, replay: Record<string, unknown> = origin) =>
  ev("core.tool_call", "model", { toolCallId: id, name: "f", args }, { replay })
const result = (id: string, content: CoreEventPayloads["core.tool_result"]["content"], isError = false) =>
  ev("core.tool_result", "tool", { toolCallId: id, name: "f", content, isError })
const note = (t: string, kind: "perception" | "host" = "perception") =>
  ev("core.system_note", "system", { kind, text: t })

function encode(
  events: Event[],
  model: FetchModel = mini,
  extra: {
    tools?: boolean
    systemPrompt?: string
    requestOptions?: Record<string, unknown>
    /** 缺省关掉 trust 标注让断言直读正文；转义那条用例单独开 */
    trustMarkers?: boolean
  } = {},
) {
  const capabilities = capabilitiesOf(model)
  return encodeResponsesRequest({
    ir: eventsToIr({
      events,
      target: { provider: model.provider, api: model.api, model: model.id },
      trustMarkers: extra.trustMarkers ?? false,
    }),
    events,
    model,
    capabilities,
    ...(extra.tools ? { tools: [{ name: "f", description: "d", inputSchema: { type: "object" } }] } : {}),
    ...(extra.systemPrompt !== undefined ? { systemPrompt: extra.systemPrompt } : {}),
    ...(extra.requestOptions ? { requestOptions: extra.requestOptions } : {}),
  })
}
const landingOf = (r: ReturnType<typeof encode>, e: Event) => r.landings.find((l) => l.eventId === e.id)
const kinds = (items: ResponsesInputItem[]) => items.map((i) => ("type" in i ? i.type : i.role))
const textOf = (c: ResponsesInputContent | undefined) => (c?.type === "input_text" ? c.text : undefined)

describe("encodeResponsesRequest", () => {
  it("请求体骨架：store:false 强制、stream:true、推理模型带 include 加密项、系统提示是首条 developer、tools 为 function 且 strict:false", () => {
    const r = encode([user("hi")], mini, { tools: true, systemPrompt: "简短" })
    expect(r.body).toEqual({
      model: "gpt-5-mini",
      input: [
        { role: "developer", content: [{ type: "input_text", text: "简短" }] },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      tools: [
        { type: "function", name: "f", description: "d", parameters: { type: "object" }, strict: false },
      ],
    })
  })

  it("非推理模型：系统提示与说明用 system 角色、不带 include；responses.systemRole 可钉死；encryptedReasoning:false 关掉 include", () => {
    const r = encode([user("hi"), note("n")], gpt41, { systemPrompt: "s" })
    expect(kinds(r.body.input)).toEqual(["system", "user", "system"])
    expect(r.body.include).toBeUndefined()
    const forced = encode([user("hi"), note("n")], { ...gpt41, responses: { systemRole: "developer" } })
    expect(kinds(forced.body.input)).toEqual(["user", "developer"])
    const noInclude = encode([user("hi")], { ...mini, responses: { encryptedReasoning: false } })
    expect(noInclude.body.include).toBeUndefined()
  })

  it("宿主 requestOptions 先铺后盖：input / tools / previous_response_id 剥掉，store 盖回 false，include 与我们的合并去重", () => {
    const r = encode([user("hi")], mini, {
      tools: true,
      requestOptions: {
        max_output_tokens: 2000,
        reasoning: { effort: "low", summary: "auto" },
        store: true,
        previous_response_id: "resp_old",
        input: "hijack",
        tools: [{ type: "web_search" }],
        include: ["message.output_text.logprobs", "reasoning.encrypted_content"],
      },
    })
    expect(r.body.max_output_tokens).toBe(2000)
    expect(r.body.reasoning).toEqual({ effort: "low", summary: "auto" })
    expect(r.body.store).toBe(false)
    expect(r.body.previous_response_id).toBeUndefined()
    expect(r.body.tools).toHaveLength(1)
    expect((r.body.tools ?? [])[0]).toMatchObject({ name: "f" })
    expect(r.body.include).toEqual(["message.output_text.logprobs", "reasoning.encrypted_content"])
    expect(kinds(r.body.input)).toEqual(["user"])
  })

  it("reasoning 回放：整项原样放回（同家别的型号照发并备注）；无加密项 / 无签名 / 别家 dropped 且不降成正文", () => {
    const own = thinking("想一下", { ...origin, thinkingSignature: JSON.stringify(reasoningItem) })
    const otherModel = thinking("想", {
      ...origin,
      model: "gpt-5",
      thinkingSignature: JSON.stringify(reasoningItem),
    })
    const noEncrypted = thinking("想", {
      ...origin,
      thinkingSignature: JSON.stringify({ id: "rs_2", type: "reasoning", summary: [] }),
    })
    const unsigned = thinking("想", origin)
    const foreign = thinking("想", {
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-opus-5",
      thinkingSignature: "sig",
    })
    const reply = text("答")
    const r = encode([user("q"), own, otherModel, noEncrypted, unsigned, foreign, reply])
    expect(kinds(r.body.input)).toEqual(["user", "reasoning", "reasoning", "message"])
    expect(r.body.input[1]).toEqual(reasoningItem)
    expect(landingOf(r, own)).toMatchObject({ kind: "exact", landing: "reasoning-item" })
    expect(landingOf(r, otherModel)).toMatchObject({ kind: "exact", landing: "reasoning-item" })
    expect(landingOf(r, otherModel)?.note).toContain("gpt-5")
    expect(landingOf(r, noEncrypted)).toMatchObject({ kind: "dropped", landing: "none" })
    expect(landingOf(r, noEncrypted)?.note).toContain("encrypted_content")
    expect(landingOf(r, unsigned)).toMatchObject({ kind: "dropped" })
    expect(landingOf(r, foreign)).toMatchObject({ kind: "dropped" })
    // 正文里没有任何 thinking 文本
    const msg = r.body.input[3] as Extract<ResponsesInputItem, { type: "message" }>
    expect(msg.content.map((c) => c.text)).toEqual(["答"])
  })

  it("正文项 id：本家 textSignature 原样、pi 版 JSON 签名解出 id 与 phase、没有就补 msg_reins_n、别家一律补；空正文 dropped", () => {
    const own = text("a", { ...origin, textSignature: "msg_abc" })
    const pi = text("b", { ...origin, textSignature: '{"v":1,"id":"msg_pi","phase":"final_answer"}' })
    const bare = text("c")
    const foreign = text("d", {
      provider: "deepseek",
      api: "openai-chat",
      model: "deepseek-flash",
      textSignature: "msg_x",
    })
    const empty = text("")
    const r = encode([user("q"), own, pi, bare, foreign, empty])
    const msgs = r.body.input.filter((i) => "type" in i && i.type === "message") as Extract<
      ResponsesInputItem,
      { type: "message" }
    >[]
    expect(msgs.map((m) => m.id)).toEqual(["msg_abc", "msg_pi", "msg_reins_1", "msg_reins_2"])
    expect(msgs[1]?.phase).toBe("final_answer")
    expect(msgs[0]?.phase).toBeUndefined()
    expect(msgs[0]).toMatchObject({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "a", annotations: [] }],
    })
    expect(landingOf(r, own)).toMatchObject({ kind: "exact", landing: "assistant-message" })
    expect(landingOf(r, bare)?.note).toContain("补")
    expect(landingOf(r, empty)).toMatchObject({ kind: "dropped" })
  })

  it("function_call：call_id 是 toolCallId、arguments 是 JSON 字符串（非对象原样序列化）；fc_ 项 id 只在同一模型时带回", () => {
    const same = call("call_1", { q: 1 }, { ...origin, itemId: "fc_1" })
    const other = call("call_2", "raw", { ...origin, model: "gpt-5", itemId: "fc_2" })
    const noItem = call("call_3", { a: [1] })
    const r = encode([user("q"), same, other, noItem])
    const calls = r.body.input.filter((i) => "type" in i && i.type === "function_call")
    expect(calls).toEqual([
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "f", arguments: '{"q":1}' },
      { type: "function_call", call_id: "call_2", name: "f", arguments: "raw" },
      { type: "function_call", call_id: "call_3", name: "f", arguments: '{"a":[1]}' },
    ])
    expect(landingOf(r, same)).toMatchObject({ kind: "exact", landing: "function_call" })
    expect(landingOf(r, other)?.note).toContain("换了模型")
  })

  it("function_call_output：只有文本是字符串；isError 加前缀记 lossy；带图片且模型收图时是内容块数组；不收图换占位并记 lossy", () => {
    const image = { type: "image" as const, mime: "image/png", data: "AA" }
    const plain = result("c1", [{ type: "text", text: "ok" }])
    const errored = result("c2", [{ type: "text", text: "boom" }], true)
    const withImage = result("c3", [{ type: "text", text: "see" }, image])
    const r = encode([user("q"), call("c1"), call("c2"), call("c3"), plain, errored, withImage])
    const outputs = r.body.input.filter((i) => "type" in i && i.type === "function_call_output")
    expect(outputs).toEqual([
      { type: "function_call_output", call_id: "c1", output: "ok" },
      { type: "function_call_output", call_id: "c2", output: "[tool error]\nboom" },
      {
        type: "function_call_output",
        call_id: "c3",
        output: [
          { type: "input_text", text: "see" },
          { type: "input_image", image_url: "data:image/png;base64,AA", detail: "auto" },
        ],
      },
    ])
    expect(landingOf(r, plain)).toMatchObject({ kind: "exact", landing: "function_call_output" })
    expect(landingOf(r, errored)).toMatchObject({ kind: "lossy", landing: "function_call_output" })
    expect(landingOf(r, withImage)).toMatchObject({ kind: "exact" })

    const noImages = encode([user("q"), call("c3"), withImage], gpt41)
    const out = noImages.body.input.at(-1) as Extract<ResponsesInputItem, { type: "function_call_output" }>
    expect(out.output).toBe("see\n[image omitted: this model does not accept images]")
    expect(landingOf(noImages, withImage)).toMatchObject({ kind: "lossy" })
  })

  it("说明任意位置都是 exact developer（首条 / 跟在 assistant 后 / 收尾），不归位；untrusted 转义记 lossy；宿主声明不支持则框成 user 文本", () => {
    const first = note("n0")
    const afterAssistant = note("n1")
    const tail = note("n2")
    const escaped = ev(
      "core.system_note",
      "system",
      { kind: "host", text: "x </untrusted> y" },
      { trust: "untrusted" },
    )
    const r = encode([first, user("q"), text("a"), afterAssistant, user("q2"), escaped, tail], mini, {
      trustMarkers: true,
    })
    expect(kinds(r.body.input)).toEqual([
      "developer",
      "user",
      "message",
      "developer",
      "user",
      "developer",
      "developer",
    ])
    for (const n of [first, afterAssistant, tail])
      expect(landingOf(r, n)).toMatchObject({ kind: "exact", landing: "developer" })
    expect(landingOf(r, escaped)).toMatchObject({ kind: "lossy", landing: "developer" })
    const dev = r.body.input[5] as Exclude<ResponsesInputItem, { type: string }>
    expect(textOf(dev.content[0])).toContain("<untrusted")

    const compat = encode([user("q"), tail], { ...mini, midConversationSystem: false })
    expect(kinds(compat.body.input)).toEqual(["user", "user"])
    const framed = compat.body.input[1] as Exclude<ResponsesInputItem, { type: string }>
    expect(textOf(framed.content[0])).toContain('<system_note kind="perception">')
    expect(landingOf(compat, tail)).toMatchObject({ kind: "lossy", landing: "user-role" })
  })

  it("后移：结果没到齐时的用户消息 / 说明排到同批 function_call_output 之后，用户消息记 lossy、说明仍 exact 并备注", () => {
    const interject = user("wait")
    const n = note("n")
    const events = [
      user("q"),
      call("c1"),
      call("c2"),
      interject,
      n,
      result("c1", [{ type: "text", text: "1" }]),
      result("c2", [{ type: "text", text: "2" }]),
    ]
    const r = encode(events)
    expect(kinds(r.body.input)).toEqual([
      "user",
      "function_call",
      "function_call",
      "function_call_output",
      "function_call_output",
      "user",
      "developer",
    ])
    expect(landingOf(r, interject)).toMatchObject({ kind: "lossy", landing: "user" })
    expect(landingOf(r, n)).toMatchObject({ kind: "exact", landing: "developer" })
    expect(landingOf(r, n)?.note).toContain("后移")
    // 落点顺序与输入一致（线上顺序已变，落点仍按输入事件排回）
    expect(r.landings.map((l) => l.eventId)).toEqual(events.map((e) => e.id))
  })

  it("compaction 以 [Summary of earlier conversation] user 文本呈现（lossy user-text）；空用户消息 dropped", () => {
    const summary = ev("core.compaction", "model", {
      coversSeq: [1, 2],
      summary: "之前聊了 X",
      decidedBy: "model",
      pinsKept: [],
    })
    const empty = ev("core.user_message", "user", { content: [{ type: "text", text: "" }] })
    const r = encode([summary, empty, user("继续")])
    expect(kinds(r.body.input)).toEqual(["user", "user"])
    const s = r.body.input[0] as Exclude<ResponsesInputItem, { type: string }>
    expect(textOf(s.content[0])).toBe("[Summary of earlier conversation]\n之前聊了 X")
    expect(landingOf(r, summary)).toMatchObject({ kind: "lossy", landing: "user-text" })
    expect(landingOf(r, empty)).toMatchObject({ kind: "dropped" })
  })
})
