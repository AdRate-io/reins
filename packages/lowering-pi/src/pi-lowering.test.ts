/**
 * 降级层双向测试：用假 fetch 截获发往厂商的请求体、回放一段假的 SSE 响应。
 * 不联网、不花钱；真实往返用 spikes 里的脚本带 key 跑（见 TASKS T7 备注）。
 */
import {
  type CoreEventDraft,
  type CoreEventOf,
  createCoreEvent,
  createCoreRegistry,
  type Event,
} from "@reins/core"
import { describe, expect, it } from "vitest"
import { declaredLandings, LOSS_MATRIX } from "./loss-matrix.js"
import { PiAiLowering } from "./pi-lowering.js"
import { rewriteAnthropicPayload } from "./system-note.js"

const registry = createCoreRegistry()
const SESSION = "s1"
let seq = 0
function ev<T extends Parameters<typeof createCoreEvent>[1]["type"]>(
  type: T,
  payload: CoreEventOf<T>["payload"],
  extra: { replay?: Record<string, unknown> } = {},
): CoreEventOf<T> {
  seq += 1
  const actor =
    type.startsWith("core.model_") || type === "core.tool_call"
      ? "model"
      : type === "core.tool_result"
        ? "tool"
        : type === "core.user_message"
          ? "user"
          : "system"
  return createCoreEvent(registry, {
    type,
    payload,
    sessionId: SESSION,
    seq,
    actor,
    at: 1_800_000_000_000 + seq,
    id: `e${seq}`,
    ...extra,
  })
}

const ANTHROPIC = { provider: "anthropic", api: "anthropic-messages", model: "claude-opus-5" }
const OPENAI = { provider: "openai", api: "openai-responses", model: "gpt-5.4" }

/** 一段已投影的时间线：摘要、用户、思考+调用、结果、感知注入、回答、新问题 */
function timeline(
  origin: { provider: string; api: string; model: string },
  thinkingSignature: string,
  toolCallId: string,
): Event[] {
  seq = 0
  return [
    ev("core.compaction", {
      coversSeq: [1, 8],
      summary: "用户在查各地天气",
      decidedBy: "model",
      pinsKept: [],
    }),
    ev("core.user_message", { content: [{ type: "text", text: "帮我查上海天气" }] }),
    ev("core.model_thinking", { text: "先调工具" }, { replay: { ...origin, thinkingSignature } }),
    ev(
      "core.tool_call",
      { toolCallId, name: "get_weather", args: { city: "上海" } },
      { replay: { ...origin } },
    ),
    ev("core.tool_result", {
      toolCallId,
      name: "get_weather",
      content: [{ type: "text", text: "晴 28℃" }],
      isError: false,
    }),
    ev("core.system_note", { kind: "perception", text: "Context 50-70% used." }),
    ev("core.model_text", { text: "上海晴，28℃。" }, { replay: { ...origin } }),
    ev("core.user_message", { content: [{ type: "text", text: "那北京呢" }] }),
  ]
}

const TOOLS = [
  {
    name: "get_weather",
    description: "查天气",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
]

/** 截获请求体并返回预设 SSE 的假 fetch */
function fakeFetch(sse: string) {
  const captured: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    captured.push({ url: String(input), body: JSON.parse(String(init?.body)), headers })
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
  }) as typeof globalThis.fetch
  return { fetch, captured }
}

async function collect(gen: AsyncGenerator<CoreEventDraft, unknown>) {
  const drafts: CoreEventDraft[] = []
  let result = await gen.next()
  while (!result.done) {
    drafts.push(result.value)
    result = await gen.next()
  }
  return { drafts, outcome: result.value }
}

// ---------------- Anthropic Messages ----------------

const anthropicSse = (() => {
  const e = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  return (
    e("message_start", {
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 120, output_tokens: 0, cache_read_input_tokens: 100 },
      },
    }) +
    e("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }) +
    e("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "查北京" } }) +
    e("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig-2" } }) +
    e("content_block_stop", { index: 0 }) +
    e("content_block_start", { index: 1, content_block: { type: "text", text: "" } }) +
    e("content_block_delta", { index: 1, delta: { type: "text_delta", text: "我来查" } }) +
    e("content_block_delta", { index: 1, delta: { type: "text_delta", text: "北京。" } }) +
    e("content_block_stop", { index: 1 }) +
    e("content_block_start", {
      index: 2,
      content_block: { type: "tool_use", id: "toolu_2", name: "get_weather", input: {} },
    }) +
    e("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: '{"city":' } }) +
    e("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: '"北京"}' } }) +
    e("content_block_stop", { index: 2 }) +
    e("message_delta", {
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 42 },
    }) +
    e("message_stop", {})
  )
})()

describe("PiAiLowering — Anthropic Messages", () => {
  const { fetch, captured } = fakeFetch(anthropicSse)
  const lowering = new PiAiLowering({ apiKey: () => "sk-test", fetch })
  const model = { provider: "anthropic", id: "claude-opus-5" }

  it("capabilities：Opus 5 支持中途 system 与 task budget；Sonnet 5 不支持中途 system", () => {
    const caps = lowering.capabilities(model)
    expect(caps).toMatchObject({
      api: "anthropic-messages",
      midConversationSystem: true,
      thinkingReplay: true,
      taskBudget: true,
      images: true,
    })
    expect(caps.contextWindow).toBeGreaterThan(100_000)
    expect(
      lowering.capabilities({ provider: "anthropic", id: "claude-sonnet-5" }).midConversationSystem,
    ).toBe(false)
  })

  it("往返：请求体角色正确、thinking 带签名回放、tool 配对、system_note 归位；响应译回三条草稿", async () => {
    const req = lowering.toRequest({
      events: timeline(ANTHROPIC, "sig-1", "toolu_1"),
      tools: TOOLS,
      model,
      systemPrompt: "你是天气助手",
    })
    expect(req.landings.map((l) => `${l.type}:${l.kind}:${l.landing}`)).toEqual([
      "core.compaction:lossy:user-text",
      "core.user_message:exact:user",
      "core.model_thinking:exact:thinking-block",
      "core.tool_call:exact:tool_use",
      "core.tool_result:exact:tool_result",
      "core.system_note:exact:system",
      "core.model_text:exact:assistant-text",
      "core.user_message:exact:user",
    ])

    const deltas: string[] = []
    const { drafts, outcome } = await collect(
      lowering.stream(req, { onDelta: (d) => deltas.push(`${d.kind}:${d.delta}`) }),
    )

    // ---- 出站请求体 ----
    const sent = captured[0]
    expect(sent).toBeDefined()
    if (!sent) return
    expect(sent.headers["x-api-key"]).toBe("sk-test")
    const body = sent.body as {
      model: string
      system: unknown
      messages: { role: string; content: unknown }[]
      tools: { name: string; input_schema: unknown }[]
    }
    expect(body.model).toBe("claude-opus-5")
    expect(JSON.stringify(body.system)).toContain("你是天气助手")
    expect(body.tools.map((t) => t.name)).toEqual(["get_weather"])
    expect(body.tools[0]?.input_schema).toMatchObject({ type: "object", required: ["city"] })

    // 角色序列：摘要(user) → 用户 → assistant[thinking, tool_use] → user[tool_result] → system → assistant[text] → user
    const roles = body.messages.map((m) => m.role)
    expect(roles.slice(0, 7)).toEqual(["user", "user", "assistant", "user", "system", "assistant", "user"])
    const text = (m: { content: unknown }) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    expect(text(body.messages[0] as { content: unknown })).toContain("[Summary of earlier conversation]")
    expect(text(body.messages[0] as { content: unknown })).toContain("用户在查各地天气")

    const assistant1 = body.messages[2]?.content as {
      type: string
      signature?: string
      id?: string
      input?: unknown
    }[]
    expect(assistant1.map((b) => b.type)).toEqual(["thinking", "tool_use"])
    expect(assistant1[0]?.signature).toBe("sig-1")
    expect(assistant1[1]).toMatchObject({ id: "toolu_1", input: { city: "上海" } })

    const toolResultMsg = body.messages[3]?.content as {
      type: string
      tool_use_id: string
      content: unknown
    }[]
    expect(toolResultMsg[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" })
    // trust 标注（§14）：工具输出在线协议里被 <untrusted source="tool:get_weather"> 包住
    const wire = JSON.stringify(toolResultMsg[0]?.content)
    expect(wire).toContain('<untrusted source=\\"tool:get_weather\\">')
    expect(wire).toContain("</untrusted>")

    // 中途 system：紧跟 user（tool_result），后接 assistant；标记不上线
    const sys = body.messages[4] as { content: { type: string; text: string }[] }
    expect(sys.content[0]?.text).toBe("Context 50-70% used.")
    expect(JSON.stringify(body)).not.toContain("[[reins:system_note]]")

    // ---- 入站草稿 ----
    expect(drafts.map((d) => d.type)).toEqual(["core.model_thinking", "core.model_text", "core.tool_call"])
    expect(drafts[0]).toMatchObject({
      actor: "model",
      payload: { text: "查北京" },
      replay: {
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-opus-5",
        thinkingSignature: "sig-2",
      },
    })
    expect(drafts[1]?.payload).toEqual({ text: "我来查北京。" })
    expect(drafts[2]?.payload).toEqual({ toolCallId: "toolu_2", name: "get_weather", args: { city: "北京" } })
    expect(outcome).toMatchObject({
      stopReason: "toolUse",
      usage: { input: 120, output: 42, cacheRead: 100 },
    })
    expect(deltas).toEqual([
      "thinking:查北京",
      "text:我来查",
      "text:北京。",
      'tool_args:{"city":',
      'tool_args:"北京"}',
    ])
  })

  it("殿后的 system_note 经 onPayload 改写后：请求顶层带自动缓存字段，块级断点不落在 system 与前一条 user 上", async () => {
    const { fetch: f, captured: c } = fakeFetch(anthropicSse)
    const lo = new PiAiLowering({ apiKey: () => "sk-test", fetch: f })
    seq = 0
    const events: Event[] = [
      ev("core.user_message", { content: [{ type: "text", text: "帮我查上海天气" }] }),
      ev("core.system_note", { kind: "perception", text: "Context <50% used." }),
    ]
    const req = lo.toRequest({ events, tools: TOOLS, model, systemPrompt: "你是天气助手" })
    await collect(lo.stream(req))
    const body = c[0]?.body as {
      cache_control?: unknown
      system?: { cache_control?: unknown }[]
      messages: { role: string; content: { type: string; cache_control?: unknown }[] | string }[]
    }
    expect(body.cache_control).toEqual({ type: "ephemeral" })
    // 末尾可能还有 pi-ai 为 Opus 5 追加的空 effort system 消息，与我们的 system 相邻成组
    expect(body.messages.slice(0, 2).map((m) => m.role)).toEqual(["user", "system"])
    expect(body.messages[1]?.content).toEqual([{ type: "text", text: "Context <50% used." }])
    for (const m of body.messages) {
      const blocks = typeof m.content === "string" ? [] : m.content
      expect(blocks.some((b) => b.cache_control !== undefined)).toBe(false)
    }
    // pi-ai 原有的系统提示断点还在，总断点数不超过 4
    expect(body.system?.some((b) => b.cache_control !== undefined)).toBe(true)
  })

  it("不支持中途 system 的模型：system_note 以标签包住走 user，声明 lossy", () => {
    const req = lowering.toRequest({
      events: timeline(ANTHROPIC, "sig-1", "toolu_1"),
      model: { provider: "anthropic", id: "claude-sonnet-5" },
    })
    const note = req.landings.find((l) => l.type === "core.system_note")
    expect(note).toMatchObject({ kind: "lossy", landing: "user-role" })
    const msgs = req.payload.context.messages as { role: string; content: unknown }[]
    const noteMsg = msgs.find((m) => typeof m.content === "string" && m.content.includes("<system_note"))
    expect(noteMsg?.role).toBe("user")
    expect(noteMsg?.content).toBe('<system_note kind="perception">\nContext 50-70% used.\n</system_note>')
  })

  it("无签名 thinking 与来自别家的 thinking 记为 lossy；同家不同模型 id 仍 exact 但留备注", () => {
    seq = 0
    const events = [
      ev("core.user_message", { content: [{ type: "text", text: "hi" }] }),
      ev("core.model_thinking", { text: "无签名" }),
      ev("core.model_thinking", { text: "别家的" }, { replay: { ...OPENAI, thinkingSignature: "{}" } }),
      ev(
        "core.model_thinking",
        { text: "带日期的同款" },
        { replay: { ...ANTHROPIC, model: "claude-opus-5-20260301", thinkingSignature: "s" } },
      ),
      ev("core.model_text", { text: "ok" }, { replay: { ...ANTHROPIC } }),
    ]
    const req = lowering.toRequest({ events, model })
    expect(req.landings.slice(1, 4).map((l) => [l.kind, l.landing])).toEqual([
      ["lossy", "text-or-drop"],
      ["lossy", "provider-dependent"],
      ["exact", "thinking-block"],
    ])
    expect(req.landings[3]?.note).toContain("claude-opus-5-20260301")
    // 来源不同的 model 事件不合并进同一条 assistant 消息
    const roles = (req.payload.context.messages as { role: string }[]).map((m) => m.role)
    expect(roles).toEqual(["user", "assistant", "assistant", "assistant", "assistant"])
  })
})

describe("rewriteAnthropicPayload 归位规则", () => {
  const MARK = "[[reins:system_note]]"
  const u = (text: string) => ({ role: "user", content: text })
  const a = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })
  const s = (text: string) => ({ role: "user", content: `${MARK}${text}` })
  const roles = (p: unknown) => (p as { messages: { role: string }[] }).messages.map((m) => m.role)

  it("system_note 后面紧跟 user 时，挪到该 user 之后、下一条 assistant 之前", () => {
    const out = rewriteAnthropicPayload({ messages: [u("a"), a("b"), s("note"), u("c"), a("d")] })
    expect(roles(out)).toEqual(["user", "assistant", "user", "system", "assistant"])
  })

  it("末尾没有 assistant 时收尾，且排在 pi-ai 的 effort 空 system 之前", () => {
    const out = rewriteAnthropicPayload({
      messages: [
        u("a"),
        a("b"),
        s("note"),
        u("c"),
        { role: "system", content: [], output_config: { effort: "high" } },
      ],
    })
    expect(roles(out)).toEqual(["user", "assistant", "user", "system", "system"])
    const msgs = (out as { messages: { content: unknown }[] }).messages
    expect(msgs[3]?.content).toEqual([{ type: "text", text: "note" }])
  })

  const texts = (p: unknown) =>
    (p as { messages: { role: string; content: unknown }[] }).messages.map((m) =>
      m.role === "system" ? `system:${(m.content as { text: string }[])[0]?.text}` : m.role,
    )

  it("system_note 在首位时挪到第一条 user 之后；多条相邻成组且保持原顺序", () => {
    const out = rewriteAnthropicPayload({ messages: [s("n1"), s("n2"), u("a"), a("b")] })
    expect(texts(out)).toEqual(["user", "system:n1", "system:n2", "assistant"])
  })

  it("同轮注入的多条说明（感知 + pin）在中段与末尾都保持原顺序（审查修复：此前从后往前 splice 会颠倒）", () => {
    const mid = rewriteAnthropicPayload({ messages: [u("a"), a("b"), u("c"), s("n1"), s("n2"), a("d")] })
    expect(texts(mid)).toEqual(["user", "assistant", "user", "system:n1", "system:n2", "assistant"])
    const tail = rewriteAnthropicPayload({ messages: [u("a"), a("b"), u("c"), s("n1"), s("n2")] })
    expect(texts(tail)).toEqual(["user", "assistant", "user", "system:n1", "system:n2"])
  })

  it("没有标记消息时返回 undefined，请求体原样", () => {
    expect(rewriteAnthropicPayload({ messages: [u("a"), a("b")] })).toBeUndefined()
  })

  // pi-ai 给最后一条 user（字符串内容）打断点时会把它转成单块数组，这正是我们标记消息殿后时的形状
  const cc = { type: "ephemeral" }
  const markedLast = { role: "user", content: [{ type: "text", text: `${MARK}status`, cache_control: cc }] }

  it("缺省 automatic：殿后 system_note 带着 pi-ai 打的缓存断点时，块级断点去掉、请求顶层补 cache_control", () => {
    const input = {
      system: [{ type: "text", text: "sys", cache_control: cc }],
      messages: [u("a"), a("b"), u("c"), markedLast],
    }
    const out = rewriteAnthropicPayload(input) as {
      cache_control?: unknown
      messages: { role: string; content: unknown }[]
    }
    expect(roles(out)).toEqual(["user", "assistant", "user", "system"])
    expect(out.messages[2]?.content).toBe("c")
    expect(out.messages[3]?.content).toEqual([{ type: "text", text: "status" }])
    expect(out.cache_control).toEqual(cc)
    // 传入的请求体没有被改动
    expect(input.messages[3]).toEqual(markedLast)
    expect(input).not.toHaveProperty("cache_control")
  })

  it("automatic：不殿后（没带断点）的 system_note 不动顶层；已有顶层 cache_control 不覆盖；块级断点满 4 个就放弃", () => {
    const plain = rewriteAnthropicPayload({ messages: [u("a"), a("b"), s("n"), u("c")] }) as Record<
      string,
      unknown
    >
    expect(plain).not.toHaveProperty("cache_control")

    const existing = { type: "ephemeral", ttl: "1h" }
    const kept = rewriteAnthropicPayload({
      cache_control: existing,
      messages: [u("a"), a("b"), u("c"), markedLast],
    }) as {
      cache_control: unknown
    }
    expect(kept.cache_control).toEqual(existing)

    const full = rewriteAnthropicPayload({
      system: [
        { type: "text", text: "s1", cache_control: cc },
        { type: "text", text: "s2", cache_control: cc },
      ],
      tools: [{ name: "t", cache_control: cc }],
      messages: [
        { role: "user", content: [{ type: "text", text: "a", cache_control: cc }] },
        a("b"),
        markedLast,
      ],
    }) as Record<string, unknown>
    expect(full).not.toHaveProperty("cache_control")
  })

  it("previous-user：断点挪到前一条 user 的末块，system 消息本身不带", () => {
    const input = { messages: [u("a"), a("b"), u("c"), markedLast] }
    const out = rewriteAnthropicPayload(input, { cacheBreakpoint: "previous-user" }) as {
      messages: { role: string; content: unknown }[]
    }
    expect(out.messages[2]?.content).toEqual([{ type: "text", text: "c", cache_control: cc }])
    expect(out.messages[3]?.content).toEqual([{ type: "text", text: "status" }])
    expect(input.messages[2]).toEqual(u("c"))
  })

  it("drop：断点丢弃，块级与顶层都不带", () => {
    const out = rewriteAnthropicPayload(
      { messages: [u("a"), a("b"), u("c"), markedLast] },
      { cacheBreakpoint: "drop" },
    ) as {
      cache_control?: unknown
      messages: { content: unknown }[]
    }
    expect(out.messages[2]?.content).toBe("c")
    expect(out.messages[3]?.content).toEqual([{ type: "text", text: "status" }])
    expect(out).not.toHaveProperty("cache_control")
  })

  it("previous-user 且前一条是 tool_result 的 user 消息时，断点打在最后一个 tool_result 块上", () => {
    const results = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "r1" },
        { type: "tool_result", tool_use_id: "t2", content: "r2" },
      ],
    }
    const out = rewriteAnthropicPayload(
      { messages: [u("a"), a("b"), results, markedLast] },
      { cacheBreakpoint: "previous-user" },
    ) as { messages: { content: Record<string, unknown>[] }[] }
    expect(out.messages[2]?.content[0]).not.toHaveProperty("cache_control")
    expect(out.messages[2]?.content[1]).toEqual({
      type: "tool_result",
      tool_use_id: "t2",
      content: "r2",
      cache_control: cc,
    })
  })

  it("不带断点的标记消息改写后前一条 user 不多出 cache_control", () => {
    const out = rewriteAnthropicPayload({ messages: [u("a"), a("b"), u("c"), s("status")] }) as {
      messages: { content: unknown }[]
    }
    expect(out.messages[2]?.content).toBe("c")
  })
})

// ---------------- OpenAI Responses ----------------

const openaiSse = (() => {
  const e = (data: Record<string, unknown>) => `data: ${JSON.stringify(data)}\n\n`
  const reasoningDone = {
    type: "reasoning",
    id: "rs_2",
    summary: [{ type: "summary_text", text: "想北京" }],
    encrypted_content: "enc-2",
  }
  const fnDone = {
    type: "function_call",
    id: "fc_2",
    call_id: "call_2",
    name: "get_weather",
    arguments: '{"city":"北京"}',
    status: "completed",
  }
  const response = (status: string, output: unknown[]) => ({
    id: "resp_1",
    object: "response",
    status,
    model: "gpt-5.4",
    output,
    usage: {
      input_tokens: 300,
      output_tokens: 30,
      input_tokens_details: { cached_tokens: 200 },
      output_tokens_details: { reasoning_tokens: 10 },
      total_tokens: 330,
    },
  })
  return (
    e({ type: "response.created", response: response("in_progress", []) }) +
    e({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "rs_2", summary: [] },
    }) +
    e({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "想北京" }) +
    e({ type: "response.output_item.done", output_index: 0, item: reasoningDone }) +
    e({
      type: "response.output_item.added",
      output_index: 1,
      item: { ...fnDone, arguments: "", status: "in_progress" },
    }) +
    e({ type: "response.function_call_arguments.delta", output_index: 1, delta: '{"city":"北京"}' }) +
    e({ type: "response.function_call_arguments.done", output_index: 1, arguments: '{"city":"北京"}' }) +
    e({ type: "response.output_item.done", output_index: 1, item: fnDone }) +
    e({ type: "response.completed", response: response("completed", [reasoningDone, fnDone]) })
  )
})()

describe("PiAiLowering — OpenAI Responses", () => {
  const { fetch, captured } = fakeFetch(openaiSse)
  const lowering = new PiAiLowering({
    apiKey: () => "sk-openai",
    fetch,
    requestOptions: () => ({ reasoningEffort: "medium" }),
  })
  const model = { provider: "openai", id: "gpt-5.4" }
  const reasoningItem = JSON.stringify({
    type: "reasoning",
    id: "rs_1",
    summary: [],
    encrypted_content: "enc-1",
  })

  it("capabilities：Responses 任意位置可放 developer 消息，无 task budget；不开 reasoning 就没有回放", () => {
    expect(lowering.capabilities(model)).toMatchObject({
      api: "openai-responses",
      midConversationSystem: true,
      thinkingReplay: true,
      taskBudget: false,
    })
    const plain = new PiAiLowering({ apiKey: () => "k" })
    expect(plain.capabilities(model).thinkingReplay).toBe(false)
  })

  it("往返：reasoning item 回放、function_call 配对、system_note 落 developer、store:false；响应译回草稿", async () => {
    const req = lowering.toRequest({
      events: timeline(OPENAI, reasoningItem, "call_1|fc_1"),
      tools: TOOLS,
      model,
      systemPrompt: "你是天气助手",
    })
    expect(req.landings.map((l) => `${l.type}:${l.kind}:${l.landing}`)).toEqual([
      "core.compaction:lossy:user-text",
      "core.user_message:exact:user",
      "core.model_thinking:exact:reasoning-item",
      "core.tool_call:exact:function_call",
      "core.tool_result:exact:function_call_output",
      "core.system_note:exact:developer",
      "core.model_text:exact:assistant-message",
      "core.user_message:exact:user",
    ])

    const { drafts, outcome } = await collect(lowering.stream(req))

    const sent = captured[0]
    expect(sent).toBeDefined()
    if (!sent) return
    expect(sent.headers.authorization).toBe("Bearer sk-openai")
    const body = sent.body as {
      model: string
      store: boolean
      include?: string[]
      reasoning?: unknown
      input: Record<string, unknown>[]
      tools: { type: string; name: string; parameters: unknown }[]
    }
    expect(body.model).toBe("gpt-5.4")
    expect(body.store).toBe(false)
    expect(body.include).toContain("reasoning.encrypted_content")
    expect(body.tools[0]).toMatchObject({ type: "function", name: "get_weather" })
    expect(body.reasoning).toMatchObject({ effort: "medium" })

    const kinds = body.input.map((i) => (i.type as string | undefined) ?? `message:${i.role as string}`)
    expect(kinds).toEqual([
      "message:developer", // systemPrompt
      "message:user", // compaction 摘要
      "message:user",
      "reasoning",
      "function_call",
      "function_call_output",
      "message:developer", // system_note
      "message", // assistant 文本（type: message, role: assistant）
      "message:user",
    ])
    expect(body.input[3]).toMatchObject({ type: "reasoning", id: "rs_1", encrypted_content: "enc-1" })
    expect(body.input[4]).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      id: "fc_1",
      name: "get_weather",
      arguments: '{"city":"上海"}',
    })
    expect(body.input[5]).toMatchObject({ type: "function_call_output", call_id: "call_1" })
    expect(body.input[6]).toMatchObject({
      role: "developer",
      content: [{ type: "input_text", text: "Context 50-70% used." }],
    })
    expect(JSON.stringify(body)).not.toContain("[[reins:system_note]]")

    expect(drafts.map((d) => d.type)).toEqual(["core.model_thinking", "core.tool_call"])
    const thinking = drafts[0] as Extract<CoreEventDraft, { type: "core.model_thinking" }>
    expect(thinking.payload.text).toBe("想北京")
    expect(JSON.parse(String(thinking.replay?.thinkingSignature))).toMatchObject({
      id: "rs_2",
      encrypted_content: "enc-2",
    })
    expect(drafts[1]?.payload).toEqual({
      toolCallId: "call_2|fc_2",
      name: "get_weather",
      args: { city: "北京" },
    })
    expect(outcome).toMatchObject({
      stopReason: "toolUse",
      usage: { input: 100, output: 30, cacheRead: 200 },
    })
  })
})

// ---------------- 通用 ----------------

describe("PiAiLowering — 错误与矩阵", () => {
  const lowering = new PiAiLowering({ apiKey: () => undefined })

  it("未知模型 / 不支持的 API / 缺 key 都是带码的 LoweringError", async () => {
    expect(() => lowering.capabilities({ provider: "anthropic", id: "claude-99" })).toThrow(
      "[unsupported_model]",
    )
    const custom = new PiAiLowering({
      apiKey: () => undefined,
      models: [
        {
          provider: "x",
          id: "m",
          api: "google-generative-ai",
          baseUrl: "https://x",
          reasoning: false,
          contextWindow: 1,
          maxOutputTokens: 1,
        },
      ],
    })
    expect(() => custom.capabilities({ provider: "x", id: "m" })).toThrow("[unsupported_api]")
    const req = lowering.toRequest({ events: [], model: { provider: "anthropic", id: "claude-opus-5" } })
    await expect(collect(lowering.stream(req))).rejects.toThrow("[missing_api_key]")
  })

  it("自定义模型定义能解析并声明能力", () => {
    const custom = new PiAiLowering({
      apiKey: () => "k",
      models: [
        {
          provider: "proxy",
          id: "claude-opus-5",
          api: "anthropic-messages",
          baseUrl: "https://proxy.example",
          reasoning: true,
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
          images: true,
        },
      ],
    })
    expect(custom.capabilities({ provider: "proxy", id: "claude-opus-5" })).toMatchObject({
      midConversationSystem: true,
      images: true,
      contextWindow: 200_000,
    })
  })

  it("自定义模型可声明 midConversationSystem：第三方 Anthropic 协议上游的 system_note 走 exact 落点", () => {
    const lowering = new PiAiLowering({
      apiKey: () => "k",
      models: [
        {
          provider: "deepseek",
          id: "deepseek-v4-flash",
          api: "anthropic-messages",
          baseUrl: "https://api.deepseek.com/anthropic",
          reasoning: true,
          contextWindow: 128_000,
          maxOutputTokens: 8192,
          midConversationSystem: true,
        },
        {
          provider: "deepseek",
          id: "plain",
          api: "anthropic-messages",
          baseUrl: "https://api.deepseek.com/anthropic",
          reasoning: false,
          contextWindow: 128_000,
          maxOutputTokens: 8192,
        },
      ],
    })
    expect(
      lowering.capabilities({ provider: "deepseek", id: "deepseek-v4-flash" }).midConversationSystem,
    ).toBe(true)
    // 未声明的仍按不支持处理
    expect(lowering.capabilities({ provider: "deepseek", id: "plain" }).midConversationSystem).toBe(false)
    seq = 0
    const req = lowering.toRequest({
      events: [
        ev("core.user_message", { content: [{ type: "text", text: "hi" }] }),
        ev("core.system_note", { kind: "perception", text: "status" }),
      ],
      model: { provider: "deepseek", id: "deepseek-v4-flash" },
    })
    expect(req.landings.map((l) => `${l.kind}:${l.landing}`)).toEqual(["exact:user", "exact:system"])
  })

  it("有损矩阵覆盖全部 15 种 core 事件与 ext.*，两家 API 各一份", () => {
    const coreTypes = [
      "core.user_message",
      "core.model_text",
      "core.model_thinking",
      "core.tool_call",
      "core.tool_result",
      "core.system_note",
      "core.approval_request",
      "core.approval_decision",
      "core.compaction",
      "core.handoff",
      "core.memory_op",
      "core.budget_usage",
      "core.run_paused",
      "core.run_resumed",
      "core.error",
    ]
    for (const api of ["anthropic-messages", "openai-responses"]) {
      for (const t of coreTypes) expect(declaredLandings(api, t).length, `${api} ${t}`).toBeGreaterThan(0)
      expect(declaredLandings(api, "ext.anything")[0]?.kind).toBe("dropped")
    }
    expect(Object.keys(LOSS_MATRIX)).toEqual(["anthropic-messages", "openai-responses"])
  })
})
