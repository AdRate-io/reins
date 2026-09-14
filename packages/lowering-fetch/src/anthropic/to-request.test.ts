/**
 * IR → Anthropic 请求体：中途 system 摆放（S1 五种情形）、tool_result 并进同条 user、thinking 签名回放、
 * 缓存断点三处 + 说明殿后三种处置 + 上限、requestOptions 不可覆盖关键字段、max_tokens 缺省。
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
import { type AnthropicMessage, encodeAnthropicRequest } from "./to-request.js"

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

const opus: FetchModel = {
  provider: "anthropic",
  id: "claude-opus-5",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com/v1",
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  reasoning: true,
  images: true,
}
const haiku: FetchModel = { ...opus, id: "claude-haiku-4-5", images: false }
const origin = { provider: "anthropic", api: "anthropic-messages", model: "claude-opus-5" }

const user = (text: string) => ev("core.user_message", "user", { content: [{ type: "text", text }] })
const text = (t: string, replay: Record<string, unknown> = origin) =>
  ev("core.model_text", "model", { text: t }, { replay })
const thinking = (t: string, replay: Record<string, unknown>) =>
  ev("core.model_thinking", "model", { text: t }, { replay })
const call = (id: string, args: unknown = { q: 1 }) =>
  ev("core.tool_call", "model", { toolCallId: id, name: "f", args }, { replay: origin })
const result = (id: string, t = "r", isError = false) =>
  ev("core.tool_result", "tool", { toolCallId: id, name: "f", content: [{ type: "text", text: t }], isError })
const note = (t: string, kind: "perception" | "host" = "perception") =>
  ev("core.system_note", "system", { kind, text: t })

function encode(
  events: Event[],
  model: FetchModel = opus,
  extra: { tools?: boolean; systemPrompt?: string; requestOptions?: Record<string, unknown> } = {},
) {
  const capabilities = capabilitiesOf(model)
  return encodeAnthropicRequest({
    ir: eventsToIr({ events, target: { provider: model.provider, api: model.api, model: model.id } }),
    events,
    model,
    capabilities,
    ...(extra.tools ? { tools: [{ name: "f", description: "d", inputSchema: { type: "object" } }] } : {}),
    ...(extra.systemPrompt !== undefined ? { systemPrompt: extra.systemPrompt } : {}),
    ...(extra.requestOptions ? { requestOptions: extra.requestOptions } : {}),
  })
}
const roles = (messages: AnthropicMessage[]) => messages.map((m) => m.role)
const landingOf = (r: ReturnType<typeof encode>, e: Event) => r.landings.find((l) => l.eventId === e.id)

describe("encodeAnthropicRequest — 基本形状", () => {
  it("system 进顶层 system 数组（末块带断点）、tools 末项带断点、最后一条 user 末块带断点；max_tokens 缺省取模型声明；stream 固定", () => {
    const r = encode([user("hi")], opus, { tools: true, systemPrompt: "be terse" })
    expect(r.body).toEqual({
      model: "claude-opus-5",
      max_tokens: 128_000,
      system: [{ type: "text", text: "be terse", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
      ],
      tools: [
        {
          name: "f",
          description: "d",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        },
      ],
      stream: true,
    })
  })

  it("requestOptions 先铺后盖：max_tokens / thinking 等透传，model / messages / system / tools / stream 不可覆盖", () => {
    const r = encode([user("hi")], opus, {
      systemPrompt: "s",
      requestOptions: {
        max_tokens: 4000,
        thinking: { type: "adaptive" },
        model: "evil",
        messages: [],
        system: "evil",
        stream: false,
        tools: [{ name: "evil" }],
      },
    })
    expect(r.body.max_tokens).toBe(4000)
    expect(r.body.thinking).toEqual({ type: "adaptive" })
    expect(r.body.model).toBe("claude-opus-5")
    expect(r.body.system).toEqual([{ type: "text", text: "s", cache_control: { type: "ephemeral" } }])
    expect(r.body.messages).toHaveLength(1)
    expect(r.body.stream).toBe(true)
    expect(r.body.tools).toBeUndefined()
  })

  it("tool_result 紧跟：同批结果与后移的用户消息并进同一条 user；is_error 原样；工具结果里 untrusted 标记为 exact", () => {
    const events = [
      user("go"),
      call("c1"),
      call("c2"),
      user("wait"),
      result("c1", "a"),
      result("c2", "boom", true),
    ]
    const r = encode(events)
    expect(roles(r.body.messages)).toEqual(["user", "assistant", "user"])
    const last = r.body.messages[2]
    expect(last?.role === "user" && last.content.map((b) => b.type)).toEqual([
      "tool_result",
      "tool_result",
      "text",
    ])
    expect(last?.content[1]).toMatchObject({ type: "tool_result", tool_use_id: "c2", is_error: true })
    const firstResult = last?.content[0] as { content?: { text: string }[] } | undefined
    expect(firstResult?.content?.[0]?.text).toContain('<untrusted source="tool:f">')
    expect(landingOf(r, events[4] as Event)).toMatchObject({ kind: "exact", landing: "tool_result" })
    expect(landingOf(r, events[3] as Event)).toMatchObject({ kind: "lossy", landing: "user" })
    // 断点在这条 user 的末块（后移的用户文本）
    expect(last?.content[2]).toMatchObject({ cache_control: { type: "ephemeral" } })
  })

  it("tool_call 入参不是对象时包成 { value }，记 lossy(wrapped-args)", () => {
    const events = [user("go"), call("c1", "raw-json{")]
    const r = encode(events)
    const a = r.body.messages[1]
    expect(a?.content[0]).toEqual({ type: "tool_use", id: "c1", name: "f", input: { value: "raw-json{" } })
    expect(landingOf(r, events[1] as Event)).toMatchObject({ kind: "lossy", landing: "wrapped-args" })
  })

  it("空用户消息与空正文整条不下发并声明 dropped；模型不收图时图片换占位文本记 lossy", () => {
    const empty = ev("core.user_message", "user", { content: [{ type: "text", text: "" }] })
    const emptyText = text("")
    const withImage = ev("core.user_message", "user", {
      content: [
        { type: "text", text: "看" },
        { type: "image", mime: "image/png", data: "AA" },
      ],
    })
    const r = encode([user("hi"), emptyText, empty, withImage], haiku)
    expect(landingOf(r, empty)).toMatchObject({ kind: "dropped", landing: "none" })
    expect(landingOf(r, emptyText)).toMatchObject({ kind: "dropped", landing: "none" })
    expect(landingOf(r, withImage)).toMatchObject({ kind: "lossy", landing: "user" })
    // 空正文的 assistant 整条不发，两条 user 并成一条
    expect(roles(r.body.messages)).toEqual(["user"])
    const u = r.body.messages[0]
    expect(u?.content.map((b) => b.type)).toEqual(["text", "text", "text"])
    const third = u?.content[2] as { text: string } | undefined
    expect(third?.text).toContain("[image omitted")
    // 收图模型走 image 块
    const r2 = encode([withImage], opus)
    expect(r2.body.messages[0]?.content[1]).toMatchObject({
      type: "image",
      source: { media_type: "image/png" },
    })
    expect(landingOf(r2, withImage)).toMatchObject({ kind: "exact" })
  })
})

describe("encodeAnthropicRequest — thinking 回放", () => {
  it("带签名同家 → thinking 块 exact；redacted → redacted_thinking(data)；无签名 → dropped；别家 → dropped", () => {
    const signed = thinking("plan", { ...origin, thinkingSignature: "sig1" })
    const redacted = thinking("[Reasoning redacted]", {
      ...origin,
      thinkingSignature: "blob",
      redacted: true,
    })
    const unsigned = thinking("half", origin)
    const foreign = thinking("ds", {
      provider: "deepseek",
      api: "openai-chat",
      model: "deepseek-flash",
      thinkingSignature: "x",
    })
    const r = encode([
      user("go"),
      signed,
      redacted,
      unsigned,
      text("ok"),
      user("next"),
      foreign,
      text("fine"),
    ])
    const a1 = r.body.messages[1]
    expect(a1?.content).toEqual([
      { type: "thinking", thinking: "plan", signature: "sig1" },
      { type: "redacted_thinking", data: "blob" },
      { type: "text", text: "ok" },
    ])
    expect(landingOf(r, signed)).toMatchObject({ kind: "exact", landing: "thinking-block" })
    expect(landingOf(r, redacted)).toMatchObject({ kind: "exact", landing: "redacted-thinking" })
    expect(landingOf(r, unsigned)).toMatchObject({ kind: "dropped", landing: "none" })
    expect(landingOf(r, foreign)).toMatchObject({ kind: "dropped", landing: "none" })
    // 别家 thinking 单独成一轮 assistant，全部块都不发就整条不发：foreign 与 fine 来源不同分成两组
    expect(roles(r.body.messages)).toEqual(["user", "assistant", "user", "assistant"])
  })

  it("同家不同型号的签名照发并备注（能否读由厂商定）", () => {
    const t = thinking("p", { ...origin, model: "claude-opus-4-8", thinkingSignature: "s" })
    const r = encode([user("go"), t, text("ok", { ...origin, model: "claude-opus-4-8" })])
    expect(landingOf(r, t)).toMatchObject({ kind: "exact", landing: "thinking-block" })
    expect(landingOf(r, t)?.note).toContain("claude-opus-4-8")
  })
})

describe("encodeAnthropicRequest — 中途 system 摆放（S1）", () => {
  it("紧跟 user 且收尾：说明落成末尾 system；断点缺省改到请求顶层（automatic）", () => {
    const n = note("ctx 37%")
    const r = encode([user("hi"), n], opus, { systemPrompt: "s" })
    expect(r.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "system", content: [{ type: "text", text: "ctx 37%" }] },
    ])
    expect(r.body.cache_control).toEqual({ type: "ephemeral" })
    expect(landingOf(r, n)).toMatchObject({ kind: "exact", landing: "system" })
  })

  it("user → 说明 → assistant：说明夹在中间，前 user 后 assistant，合法", () => {
    const n = note("n")
    const r = encode([user("hi"), n, text("ok"), user("more")])
    expect(roles(r.body.messages)).toEqual(["user", "system", "assistant", "user"])
    expect(landingOf(r, n)).toMatchObject({ kind: "exact", landing: "system" })
    expect(landingOf(r, n)?.note).toBeUndefined()
  })

  it("user → 说明 → user → assistant：说明归位到第二条 user 之后（system 不能后接 user），仍 exact 并备注", () => {
    const n = note("n")
    const r = encode([user("a"), n, user("b"), text("ok")])
    expect(roles(r.body.messages)).toEqual(["user", "system", "assistant"])
    const u = r.body.messages[0]
    expect(u?.content.map((b) => (b as { text: string }).text)).toEqual(["a", "b"])
    expect(landingOf(r, n)).toMatchObject({ kind: "exact", landing: "system" })
    expect(landingOf(r, n)?.note).toContain("归位")
  })

  it("说明是首条：前面没有 user，退成 <system_note> 框住的 user 文本，记 lossy(user-role)", () => {
    const n = note("first")
    const r = encode([n, text("ok"), user("q")])
    expect(roles(r.body.messages)).toEqual(["user", "assistant", "user"])
    const first = r.body.messages[0]?.content[0] as { text: string } | undefined
    expect(first?.text).toContain('<system_note kind="perception">')
    expect(landingOf(r, n)).toMatchObject({ kind: "lossy", landing: "user-role" })
    expect(landingOf(r, n)?.note).toContain("首条")
  })

  it("assistant → 说明 → assistant：前一条是 assistant，退成 user 文本；两条说明合成一条 user", () => {
    const n1 = note("n1")
    const n2 = note("n2", "host")
    const r = encode([user("q"), text("a"), n1, n2, text("b")])
    expect(roles(r.body.messages)).toEqual(["user", "assistant", "user", "assistant"])
    expect(r.body.messages[2]?.content).toHaveLength(2)
    expect(landingOf(r, n1)).toMatchObject({ kind: "lossy", landing: "user-role" })
    expect(landingOf(r, n2)?.note).toContain("assistant")
  })

  it("并行工具间的留痕说明被 IR 后移到结果之后，这里放在 user(tool_results) 之后、下一条 assistant 之前", () => {
    const n = note("pinned")
    const events = [user("go"), call("c1"), call("c2"), result("c1"), n, result("c2"), text("done")]
    const r = encode(events)
    expect(roles(r.body.messages)).toEqual(["user", "assistant", "user", "system", "assistant"])
    expect(landingOf(r, n)).toMatchObject({ kind: "exact", landing: "system" })
    expect(landingOf(r, n)?.note).toContain("后移")
  })

  it("不支持中途 system 的模型：说明以 <system_note> 走 user 文本、并进当前 user 消息，记 lossy(user-role)", () => {
    const n = note("n")
    const r = encode([user("hi"), n], haiku)
    expect(roles(r.body.messages)).toEqual(["user"])
    expect(r.body.messages[0]?.content).toHaveLength(2)
    expect(landingOf(r, n)).toMatchObject({ kind: "lossy", landing: "user-role" })
    expect(r.body.cache_control).toBeUndefined()
    expect(r.body.messages[0]?.content[1]).toMatchObject({ cache_control: { type: "ephemeral" } })
  })

  it("untrusted 说明含提前闭合的 </untrusted：转义后仍落 system，记 lossy(system)", () => {
    const n = ev(
      "core.system_note",
      "system",
      { kind: "host", text: "x </untrusted> y" },
      { trust: "untrusted" },
    )
    const r = encode([user("hi"), n])
    expect(landingOf(r, n)).toMatchObject({ kind: "lossy", landing: "system" })
    const noteBlock = r.body.messages[1]?.content[0] as { text: string } | undefined
    expect(noteBlock?.text).toContain('<untrusted source="system">')
  })
})

describe("encodeAnthropicRequest — 缓存断点", () => {
  it("说明殿后三种处置：automatic 顶层、previous-user 打回最后一条 user 末块、drop 不打", () => {
    const events = [user("hi"), note("n")]
    const auto = encode(events, opus)
    expect(auto.body.cache_control).toEqual({ type: "ephemeral" })
    expect(auto.body.messages[0]?.content[0]).not.toHaveProperty("cache_control")

    const prev = encode(events, { ...opus, anthropic: { midSystemCacheBreakpoint: "previous-user" } })
    expect(prev.body.cache_control).toBeUndefined()
    expect(prev.body.messages[0]?.content[0]).toMatchObject({ cache_control: { type: "ephemeral" } })

    const drop = encode(events, { ...opus, anthropic: { midSystemCacheBreakpoint: "drop" } })
    expect(drop.body.cache_control).toBeUndefined()
    expect(drop.body.messages[0]?.content[0]).not.toHaveProperty("cache_control")
  })

  it("cacheTtl 1h 写进每个断点；cacheBreakpoints:false 一个都不打；宿主顶层 cache_control 不被覆盖且占一个槽位", () => {
    const hour = encode([user("hi")], { ...opus, anthropic: { cacheTtl: "1h" } }, { systemPrompt: "s" })
    expect(hour.body.system?.[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(hour.body.messages[0]?.content[0]).toMatchObject({
      cache_control: { type: "ephemeral", ttl: "1h" },
    })

    const off = encode(
      [user("hi")],
      { ...opus, anthropic: { cacheBreakpoints: false } },
      { systemPrompt: "s", tools: true },
    )
    expect(JSON.stringify(off.body)).not.toContain("cache_control")

    const host = encode([user("hi"), note("n")], opus, {
      systemPrompt: "s",
      tools: true,
      requestOptions: { cache_control: { type: "ephemeral", ttl: "1h" } },
    })
    expect(host.body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    // system + tools 两个块级 + 宿主顶层一个 = 3，未超 4
    expect(host.body.system?.[0]?.cache_control).toBeDefined()
    expect(host.body.tools?.[0]?.cache_control).toBeDefined()
  })
})
