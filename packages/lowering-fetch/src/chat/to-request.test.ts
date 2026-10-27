/**
 * IR → Chat 请求体：角色形状、reasoning_content 方言、合并正文、图片处置、后移、requestOptions 不可覆盖关键字段。
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
import { type ChatMessage, encodeChatRequest } from "./to-request.js"

const registry = createCoreRegistry()
let seq = 0
const ev = <T extends CoreEventType>(
  type: T,
  actor: Event["actor"],
  payload: CoreEventPayloads[T],
  replay?: Record<string, unknown>,
  trust?: Event["trust"],
): Event =>
  createCoreEvent(registry, {
    type,
    actor,
    payload,
    sessionId: "s",
    seq: ++seq,
    at: 1000 + seq,
    id: `e${seq}`,
    ...(replay ? { replay } : {}),
    ...(trust ? { trust } : {}),
  })

const deepseek: FetchModel = {
  provider: "deepseek",
  id: "deepseek-flash",
  api: "openai-chat",
  baseUrl: "https://api.deepseek.com",
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  reasoning: true,
  images: true,
  chat: { reasoningContent: true },
}
const plain: FetchModel = {
  provider: "acme",
  id: "m",
  api: "openai-chat",
  baseUrl: "https://acme/v1",
  contextWindow: 8000,
  maxOutputTokens: 1000,
  reasoning: false,
  images: false,
  midConversationSystem: false,
}
const origin = { provider: "deepseek", api: "openai-chat", model: "deepseek-flash" }

function encode(
  model: FetchModel,
  events: Event[],
  extra: Partial<Parameters<typeof encodeChatRequest>[0]> = {},
) {
  return encodeChatRequest({
    ir: eventsToIr({ events, target: { provider: model.provider, api: model.api, model: model.id } }),
    events,
    model,
    capabilities: capabilitiesOf(model),
    ...extra,
  })
}
const roles = (messages: ChatMessage[]) => messages.map((m) => m.role)

describe("encodeChatRequest", () => {
  it("系统提示是首条 system；一轮 thinking+text+tool_call 合成一条 assistant，reasoning_content 回填；tool 消息紧跟", () => {
    seq = 0
    const events = [
      ev("core.user_message", "user", { content: [{ type: "text", text: "上海天气" }] }),
      ev("core.model_thinking", "model", { text: "先查" }, origin),
      ev("core.model_text", "model", { text: "查一下" }, origin),
      ev(
        "core.tool_call",
        "model",
        { toolCallId: "c1", name: "get_weather", args: { city: "上海" } },
        origin,
      ),
      ev("core.tool_result", "tool", {
        toolCallId: "c1",
        name: "get_weather",
        content: [{ type: "text", text: "晴" }],
        isError: false,
      }),
    ]
    const { body, landings } = encode(deepseek, events, {
      systemPrompt: "你是助手",
      tools: [{ name: "get_weather", description: "查天气", inputSchema: { type: "object" } }],
      requestOptions: { max_tokens: 100, messages: "hacked", stream: false, tools: [{ hacked: true }] },
    })
    expect(roles(body.messages)).toEqual(["system", "user", "assistant", "tool"])
    expect(body.messages[0]).toEqual({ role: "system", content: "你是助手" })
    expect(body.messages[1]).toEqual({ role: "user", content: "上海天气" })
    expect(body.messages[2]).toEqual({
      role: "assistant",
      content: "查一下",
      reasoning_content: "先查",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"上海"}' } },
      ],
    })
    expect(body.messages[3]).toMatchObject({ role: "tool", tool_call_id: "c1" })
    expect((body.messages[3] as { content: string }).content).toContain(
      '<untrusted source="tool:get_weather">',
    )
    expect(body.tools).toEqual([
      {
        type: "function",
        function: { name: "get_weather", description: "查天气", parameters: { type: "object" } },
      },
    ])
    // requestOptions 铺进去了，但盖不掉 messages / stream
    expect(body.max_tokens).toBe(100)
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.model).toBe("deepseek-flash")
    expect(landings.map((l) => `${l.type}:${l.kind}/${l.landing}`)).toEqual([
      "core.user_message:exact/user",
      "core.model_thinking:exact/reasoning_content",
      "core.model_text:exact/assistant-content",
      "core.tool_call:exact/tool_calls",
      "core.tool_result:exact/tool",
    ])
  })

  it("方言开着但这一轮没有 thinking：reasoning_content 给空串（DeepSeek 带 tools 时缺字段 400）；别家的 thinking 不回填", () => {
    seq = 0
    const other = { provider: "openai", api: "openai-chat", model: "gpt-4.1" }
    const { body, landings } = encode(deepseek, [
      ev("core.tool_call", "model", { toolCallId: "c1", name: "t", args: {} }, origin),
      ev("core.tool_result", "tool", { toolCallId: "c1", name: "t", content: [], isError: false }),
      ev("core.model_thinking", "model", { text: "别家的" }, other),
      ev("core.model_text", "model", { text: "ok" }, other),
    ])
    expect(body.messages[0]).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }],
    })
    expect(body.messages[2]).toEqual({ role: "assistant", content: "ok", reasoning_content: "" })
    expect(landings[2]).toMatchObject({ type: "core.model_thinking", kind: "dropped", landing: "none" })
  })

  it("方言关着（官方 OpenAI）：没有 reasoning_content 字段，thinking 记 dropped", () => {
    seq = 0
    const model = { ...deepseek, provider: "openai", id: "gpt-4o-mini", chat: {} }
    const { body, landings } = encode(model, [
      ev(
        "core.model_thinking",
        "model",
        { text: "t" },
        { ...origin, provider: "openai", model: "gpt-4o-mini" },
      ),
      ev("core.model_text", "model", { text: "a" }, { ...origin, provider: "openai", model: "gpt-4o-mini" }),
    ])
    expect(body.messages[0]).toEqual({ role: "assistant", content: "a" })
    expect(landings[0]).toMatchObject({ kind: "dropped", landing: "none" })
  })

  it("同一轮多段正文合并成一个字符串并记 lossy(merged-text)", () => {
    seq = 0
    const { body, landings } = encode(deepseek, [
      ev("core.model_text", "model", { text: "a" }, origin),
      ev("core.model_text", "model", { text: "b" }, origin),
    ])
    expect((body.messages[0] as { content: string }).content).toBe("a\n\nb")
    expect(landings.every((l) => l.kind === "lossy" && l.landing === "merged-text")).toBe(true)
  })

  it("用户消息：单段文本用字符串，带图片用 content parts + data URL；模型不收图时换占位并记 lossy", () => {
    seq = 0
    const img = ev("core.user_message", "user", {
      content: [
        { type: "text", text: "看图" },
        { type: "image", mime: "image/png", data: "AAAA" },
      ],
    })
    const withImages = encode(deepseek, [img])
    expect(withImages.body.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    })
    expect(withImages.landings[0]?.kind).toBe("exact")
    const noImages = encode(plain, [img])
    expect((noImages.body.messages[0] as { content: unknown[] }).content[1]).toEqual({
      type: "text",
      text: "[image omitted: this model does not accept images]",
    })
    expect(noImages.landings[0]).toMatchObject({ kind: "lossy", landing: "user" })
  })

  it("tool 消息：isError 加 [tool error] 前缀记 lossy；关掉上浮时图片换占位记 tool-text-only；多段文本换行拼接", () => {
    seq = 0
    const { body, landings } = encode({ ...deepseek, chat: { liftToolImages: false } }, [
      ev("core.tool_call", "model", { toolCallId: "c1", name: "t", args: {} }, origin),
      ev("core.tool_result", "tool", {
        toolCallId: "c1",
        name: "t",
        content: [
          { type: "text", text: "boom" },
          { type: "image", mime: "image/png", data: "x" },
        ],
        isError: true,
      }),
    ])
    const tool = body.messages[1] as { content: string }
    expect(tool.content.startsWith("[tool error]\n")).toBe(true)
    expect(tool.content).toContain("[image omitted: tool messages carry text only]")
    expect(landings[1]).toMatchObject({ kind: "lossy", landing: "tool-text-only" })
  })

  it("system_note：缺省走中途 system（exact）；模型声明不接受则以 <system_note> 标签走 user（lossy）；compaction 走 user 文本", () => {
    seq = 0
    const events = [
      ev("core.compaction", "system", {
        coversSeq: [1, 3],
        summary: "之前在查天气",
        decidedBy: "model",
        pinsKept: [],
      }),
      ev("core.user_message", "user", { content: [{ type: "text", text: "hi" }] }),
      ev("core.system_note", "system", { kind: "perception", text: "Context 40% used." }),
    ]
    const mid = encode(deepseek, events)
    expect(mid.body.messages[0]).toEqual({
      role: "user",
      content: "[Summary of earlier conversation]\n之前在查天气",
    })
    expect(mid.body.messages[2]).toEqual({ role: "system", content: "Context 40% used." })
    expect(mid.landings.map((l) => `${l.kind}/${l.landing}`)).toEqual([
      "lossy/user-text",
      "exact/user",
      "exact/system",
    ])
    const framed = encode(plain, events)
    expect(framed.body.messages[2]).toEqual({
      role: "user",
      content: '<system_note kind="perception">\nContext 40% used.\n</system_note>',
    })
    expect(framed.landings[2]).toMatchObject({ kind: "lossy", landing: "user-role" })
  })

  it("并行工具之间的说明与用户插话后移到同批 tool 消息之后；用户消息记 lossy、说明仍 exact 但备注后移；落点按输入顺序", () => {
    seq = 0
    const { body, landings } = encode(deepseek, [
      ev("core.tool_call", "model", { toolCallId: "a", name: "t", args: {} }, origin),
      ev("core.tool_call", "model", { toolCallId: "b", name: "t", args: {} }, origin),
      ev("core.tool_result", "tool", { toolCallId: "a", name: "t", content: [], isError: false }),
      ev("core.system_note", "system", { kind: "pin", text: "记住" }),
      ev("core.user_message", "user", { content: [{ type: "text", text: "等等" }] }),
      ev("core.tool_result", "tool", { toolCallId: "b", name: "t", content: [], isError: false }),
    ])
    expect(roles(body.messages)).toEqual(["assistant", "tool", "tool", "system", "user"])
    expect(landings.map((l) => l.eventId)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"])
    expect(landings[3]).toMatchObject({ kind: "exact", landing: "system" })
    expect(landings[3]?.note).toContain("moved after")
    expect(landings[4]).toMatchObject({ kind: "lossy", landing: "user" })
  })

  it("读侧解析失败存成字符串的入参，写侧原样送回；对象入参 JSON 化", () => {
    seq = 0
    const { body } = encode(deepseek, [
      ev("core.tool_call", "model", { toolCallId: "a", name: "t", args: "{not json" }, origin),
      ev("core.tool_call", "model", { toolCallId: "b", name: "t", args: { x: [1] } }, origin),
    ])
    const calls = (body.messages[0] as { tool_calls: { function: { arguments: string } }[] }).tool_calls
    expect(calls.map((c) => c.function.arguments)).toEqual(["{not json", '{"x":[1]}'])
  })
})

describe("延迟加载（L1）：Chat 没有原生落点", () => {
  it("deferLoading 的工具不发（模型看不见也调不了）；工具引用段展开成文本，落点仍是 exact tool", () => {
    const u = ev("core.user_message", "user", { content: [{ type: "text", text: "go" }] })
    const c = ev(
      "core.tool_call",
      "model",
      { toolCallId: "c1", name: "tool_find", args: { names: ["g"] } },
      origin,
    )
    const r = createCoreEvent(registry, {
      type: "core.tool_result",
      actor: "tool",
      trust: "system",
      payload: {
        toolCallId: "c1",
        name: "tool_find",
        content: [
          { type: "text", text: "Loaded 1 tool (g)." },
          { type: "tool_reference", name: "g", description: "dg", inputSchema: { type: "object" } },
        ],
        isError: false,
      },
      sessionId: "s",
      seq: ++seq,
      at: 1000 + seq,
      id: `e${seq}`,
    })
    const { body, landings } = encode(deepseek, [u, c, r], {
      tools: [
        { name: "f", description: "d", inputSchema: { type: "object" } },
        { name: "g", description: "dg", inputSchema: { type: "object" }, deferLoading: true },
      ],
    })
    expect(body.tools?.map((t) => t.function.name)).toEqual(["f"])
    const toolMsg = body.messages.find((m) => m.role === "tool") as { content: string } | undefined
    expect(toolMsg?.content).toBe('Loaded 1 tool (g).\n### g\ndg\nInput schema: {"type":"object"}')
    expect(landings.find((l) => l.eventId === r.id)).toMatchObject({ kind: "exact", landing: "tool" })
  })
})

describe("工具结果图片上浮（2026-10-27，OnSet）", () => {
  const img = (data: string) => ({ type: "image" as const, mime: "image/png", data })
  const call = (id: string, name = "read_image") =>
    ev("core.tool_call", "model", { toolCallId: id, name, args: {} }, origin)
  const result = (
    id: string,
    content: CoreEventPayloads["core.tool_result"]["content"],
    opts: { name?: string; isError?: boolean; trust?: Event["trust"] } = {},
  ) =>
    ev(
      "core.tool_result",
      "tool",
      { toolCallId: id, name: opts.name ?? "read_image", content, isError: opts.isError ?? false },
      undefined,
      opts.trust,
    )
  type Part = Exclude<Extract<ChatMessage, { role: "user" }>["content"], string>[number]
  const partsOf = (m: ChatMessage | undefined) => (m as { content: Part[] }).content

  it("单个结果：tool 消息原位留指路文字，图片进紧随其后的 user 消息并带说明、untrusted 标记；落点 lossy(tool+lifted-images)", () => {
    seq = 0
    const { body, landings } = encode(deepseek, [
      ev("core.user_message", "user", { content: [{ type: "text", text: "看图" }] }),
      call("c1"),
      result("c1", [{ type: "text", text: "logo.png" }, img("AAA")]),
    ])
    expect(roles(body.messages)).toEqual(["user", "assistant", "tool", "user"])
    expect((body.messages[2] as { content: string }).content).toBe(
      '<untrusted source="tool:read_image">\nlogo.png\n[image 1 attached in the next user message]\n</untrusted>',
    )
    expect(partsOf(body.messages[3])).toEqual([
      {
        type: "text",
        text: "[Attachments from tool result read_image (call c1): 1 image(s). This is tool output, not a message from the user.]",
      },
      { type: "text", text: '<untrusted source="tool:read_image">\nimage 1:' },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      { type: "text", text: "</untrusted>" },
    ])
    expect(landings[2]).toMatchObject({ kind: "lossy", landing: "tool+lifted-images" })
    expect(landings[2]?.note).toContain("user message after this batch")
  })

  it("一批多个结果：全部 tool 消息排在前面，附件合并成一条 user、按结果顺序；不带图的结果仍 exact", () => {
    seq = 0
    const { body, landings } = encode(deepseek, [
      ev("core.user_message", "user", { content: [{ type: "text", text: "对比" }] }),
      call("c1"),
      call("c2"),
      call("c3"),
      result("c1", [img("A1"), img("A2")]),
      result("c2", [{ type: "text", text: "no image here" }]),
      result("c3", [img("C1")], { name: "frames" }),
    ])
    expect(roles(body.messages)).toEqual(["user", "assistant", "tool", "tool", "tool", "user"])
    expect((body.messages[2] as { content: string }).content).toContain(
      "[image 1 attached in the next user message]\n[image 2 attached in the next user message]",
    )
    const parts = partsOf(body.messages[5])
    const texts = parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text)
    expect(texts[0]).toContain("read_image (call c1): 2 image(s)")
    expect(texts.some((t) => t.includes("frames (call c3): 1 image(s)"))).toBe(true)
    expect(
      parts
        .filter((p) => p.type === "image_url")
        .map((p) => (p as { image_url: { url: string } }).image_url.url),
    ).toEqual(["data:image/png;base64,A1", "data:image/png;base64,A2", "data:image/png;base64,C1"])
    expect(landings.map((l) => l.landing).slice(4)).toEqual([
      "tool+lifted-images",
      "tool",
      "tool+lifted-images",
    ])
    expect(landings[5]?.kind).toBe("exact")
  })

  it("同批有被后移的用户消息：附件排在它之前（图片属于工具结果）", () => {
    seq = 0
    const { body } = encode(deepseek, [
      ev("core.user_message", "user", { content: [{ type: "text", text: "看" }] }),
      call("c1"),
      ev("core.user_message", "user", { content: [{ type: "text", text: "顺便看背景色" }] }),
      result("c1", [img("A")]),
    ])
    expect(roles(body.messages)).toEqual(["user", "assistant", "tool", "user", "user"])
    expect(partsOf(body.messages[3]).some((p) => p.type === "image_url")).toBe(true)
    expect(body.messages[4]).toEqual({ role: "user", content: "顺便看背景色" })
  })

  it("同批结果之间夹着不下发的事件（ext.* 留痕、运维事件）：附件仍排在全部 tool 消息之后，不打断 tool_calls → tool 配对", () => {
    seq = 0
    const { body, landings } = encode(deepseek, [
      ev("core.user_message", "user", { content: [{ type: "text", text: "看" }] }),
      call("c1"),
      call("c2"),
      result("c1", [img("A")]),
      ev("core.budget_usage", "system", { tokens: { input: 1, output: 1 }, toolCalls: 1, wallMs: 0 }),
      result("c2", [{ type: "text", text: "ok" }]),
    ])
    expect(roles(body.messages)).toEqual(["user", "assistant", "tool", "tool", "user"])
    expect(landings[4]).toMatchObject({ kind: "dropped" })
  })

  it("isError 结果带图：前缀照加、图片照样上浮；resultTrust system 的结果不包 untrusted", () => {
    seq = 0
    const { body, landings } = encode(deepseek, [
      ev("core.user_message", "user", { content: [{ type: "text", text: "x" }] }),
      call("c1"),
      call("c2", "skill_read"),
      result("c1", [{ type: "text", text: "render failed" }, img("E")], { isError: true }),
      result("c2", [img("S")], { name: "skill_read", trust: "system" }),
    ])
    expect((body.messages[2] as { content: string }).content.startsWith("[tool error]\n")).toBe(true)
    expect((body.messages[3] as { content: string }).content).toBe(
      "[image 1 attached in the next user message]",
    )
    const texts = partsOf(body.messages[4])
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
    expect(texts).toEqual([
      "[Attachments from tool result read_image (call c1): 1 image(s). This is tool output, not a message from the user.]",
      '<untrusted source="tool:read_image">\nimage 1:',
      "</untrusted>",
      "[Attachments from tool result skill_read (call c2): 1 image(s). This is tool output, not a message from the user.]",
      "image 1:",
    ])
    expect(landings[3]?.note).toContain("[tool error] prefix")
    expect(landings[4]).toMatchObject({ kind: "lossy", landing: "tool+lifted-images" })
  })

  it("模型不收图 / 方言关掉上浮：不出附件消息，仍是占位文本与 tool-text-only", () => {
    for (const model of [
      { ...deepseek, images: false },
      { ...deepseek, chat: { liftToolImages: false } },
    ]) {
      seq = 0
      const { body, landings } = encode(model, [call("c1"), result("c1", [img("A")])])
      expect(roles(body.messages)).toEqual(["assistant", "tool"])
      expect((body.messages[1] as { content: string }).content).toContain(
        "[image omitted: tool messages carry text only]",
      )
      expect(landings[1]).toMatchObject({ kind: "lossy", landing: "tool-text-only" })
    }
  })

  it("缓存稳定：同一段历史连续两轮编码，前缀逐字节一致", () => {
    seq = 0
    const history = [
      ev("core.user_message", "user", { content: [{ type: "text", text: "看图" }] }),
      call("c1"),
      call("c2"),
      result("c1", [img("A")]),
      ev("core.system_note", "system", { kind: "perception", text: "n" }),
      result("c2", [img("B")]),
    ]
    const first = encode(deepseek, history).body.messages
    const next = encode(deepseek, [
      ...history,
      ev("core.model_text", "model", { text: "两张图都看到了" }, origin),
      ev("core.user_message", "user", { content: [{ type: "text", text: "继续" }] }),
    ]).body.messages
    expect(JSON.stringify(next.slice(0, first.length))).toBe(JSON.stringify(first))
    expect(JSON.stringify(encode(deepseek, history).body.messages)).toBe(JSON.stringify(first))
  })
})
