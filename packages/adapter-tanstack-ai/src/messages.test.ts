import { type CoreEvent, createCoreEvent, createCoreRegistry, type Event } from "@reins/core"
import { describe, expect, it } from "vitest"
import { BlockAssembler } from "./assembler.js"
import { TANSTACK_LOSS_MATRIX } from "./loss-matrix.js"
import { COMPACTION_PREFIX, importModelMessages, toModelMessages, trailingUserMessages } from "./messages.js"

const registry = createCoreRegistry()
const MODEL = { provider: "scripted", id: "scripted-1" }
const ORIGIN = { provider: "scripted", api: "tanstack-ai", model: "scripted-1" }

let seq = 0
function ev<T extends CoreEvent["type"]>(
  type: T,
  payload: Extract<CoreEvent, { type: T }>["payload"],
  extra: { actor?: Event["actor"]; replay?: Record<string, unknown> } = {},
): Event {
  seq++
  return createCoreEvent(registry, {
    type,
    payload,
    actor: extra.actor ?? (type.startsWith("core.model") || type === "core.tool_call" ? "model" : "user"),
    sessionId: "s1",
    seq,
    at: seq,
    id: `e${seq}`,
    ...(extra.replay ? { replay: extra.replay } : {}),
  } as Parameters<typeof createCoreEvent>[1]) as Event
}

describe("toModelMessages", () => {
  it("用户 / 模型 / 工具三角色逐字翻译，同一响应的 thinking + text + tool_call 合成一条 assistant", () => {
    const events = [
      ev("core.user_message", { content: [{ type: "text", text: "算 2+3" }] }),
      ev("core.model_thinking", { text: "要用工具" }, { replay: { ...ORIGIN, thinkingSignature: "sig" } }),
      ev("core.model_text", { text: "我来算" }),
      ev("core.tool_call", { toolCallId: "c1", name: "add", args: { a: 2, b: 3 } }),
      ev(
        "core.tool_result",
        { toolCallId: "c1", name: "add", content: [{ type: "text", text: "5" }], isError: false },
        { actor: "tool" },
      ),
      ev("core.model_text", { text: "答案是 5" }),
    ]
    const { messages, landings } = toModelMessages(events, { model: MODEL })
    expect(messages).toEqual([
      { role: "user", content: "算 2+3" },
      {
        role: "assistant",
        content: "我来算",
        thinking: [{ content: "要用工具", signature: "sig" }],
        toolCalls: [{ id: "c1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } }],
      },
      { role: "tool", toolCallId: "c1", name: "add", content: "5" },
      { role: "assistant", content: "答案是 5" },
    ])
    expect(landings.every((l) => l.kind === "exact")).toBe(true)
  })

  it("system_note 以标签走 user、compaction 走 user 文本，都记 lossy", () => {
    const events = [
      ev("core.user_message", { content: [{ type: "text", text: "hi" }] }),
      ev(
        "core.compaction",
        { coversSeq: [1, 1], summary: "之前聊了天气", decidedBy: "model", pinsKept: [] },
        { actor: "model" },
      ),
      ev("core.system_note", { kind: "perception", text: "上下文用了 10%" }, { actor: "system" }),
    ]
    const { messages, landings } = toModelMessages(events, { model: MODEL })
    expect(messages[1]).toEqual({ role: "user", content: `${COMPACTION_PREFIX}之前聊了天气` })
    expect(messages[2]).toEqual({
      role: "user",
      content: '<system_note kind="perception">\n上下文用了 10%\n</system_note>',
    })
    expect(landings.filter((l) => l.kind === "lossy").map((l) => l.landing)).toEqual([
      "user-text",
      "user-role",
    ])
  })

  it("thinking 无签名或来源不同不下发（dropped）；多段正文合并记 lossy；isError 落 error 字段", () => {
    const events = [
      ev("core.model_thinking", { text: "无签名" }),
      ev(
        "core.model_thinking",
        { text: "别家的" },
        { replay: { provider: "other", api: "x", model: "m", thinkingSignature: "s" } },
      ),
      ev("core.model_text", { text: "一" }),
      ev("core.model_text", { text: "二" }),
      ev("core.tool_call", { toolCallId: "c1", name: "t", args: {} }),
      ev(
        "core.tool_result",
        { toolCallId: "c1", name: "t", content: [{ type: "text", text: "坏了" }], isError: true },
        { actor: "tool" },
      ),
    ]
    const { messages, landings } = toModelMessages(events, { model: MODEL })
    expect(messages[0]).toMatchObject({ role: "assistant", content: "一\n\n二" })
    expect((messages[0] as { thinking?: unknown }).thinking).toBeUndefined()
    expect(messages[1]).toMatchObject({ role: "tool", content: "坏了", error: "坏了" })
    const kinds = landings.map((l) => `${l.type.replace("core.", "")}:${l.kind}:${l.landing}`)
    expect(kinds).toEqual([
      "model_thinking:dropped:none",
      "model_thinking:dropped:none",
      "tool_call:exact:tool-call",
      "model_text:lossy:merged-text",
      "model_text:lossy:merged-text",
      "tool_result:lossy:tool-error-field",
    ])
  })

  it("落在 tool_call 与 tool_result 之间的说明后移到同批结果之后（工具结果必须紧跟调用）", () => {
    const events = [
      ev("core.user_message", { content: [{ type: "text", text: "go" }] }),
      ev("core.tool_call", { toolCallId: "c1", name: "pin", args: { text: "p" } }),
      ev("core.tool_call", { toolCallId: "c2", name: "add", args: {} }),
      ev("core.system_note", { kind: "pin", text: "p" }, { actor: "model" }),
      ev(
        "core.tool_result",
        { toolCallId: "c1", name: "pin", content: [{ type: "text", text: "Pinned." }], isError: false },
        { actor: "tool" },
      ),
      ev(
        "core.compaction",
        { coversSeq: [1, 1], summary: "s", decidedBy: "model", pinsKept: [] },
        { actor: "model" },
      ),
      ev(
        "core.tool_result",
        { toolCallId: "c2", name: "add", content: [{ type: "text", text: "2" }], isError: false },
        { actor: "tool" },
      ),
      ev("core.model_text", { text: "done" }),
    ]
    const { messages, landings } = toModelMessages(events, { model: MODEL })
    expect(
      messages.map((m) => `${m.role}:${typeof m.content === "string" ? m.content.slice(0, 12) : "-"}`),
    ).toEqual([
      "user:go",
      "assistant:-",
      "tool:Pinned.",
      "tool:2",
      "user:<system_note",
      "user:[Summary of ",
      "assistant:done",
    ])
    const moved = landings.filter((l) => l.note?.includes("后移"))
    expect(moved.map((l) => l.type)).toEqual(["core.system_note", "core.compaction"])
    // 结果永远不来（pending）：下一条用户消息前把后移的放出
    const pending = [
      ev("core.tool_call", { toolCallId: "c9", name: "x", args: {} }),
      ev("core.system_note", { kind: "perception", text: "n" }, { actor: "system" }),
      ev("core.user_message", { content: [{ type: "text", text: "next" }] }),
    ]
    expect(toModelMessages(pending, { model: MODEL }).messages.map((m) => m.role)).toEqual([
      "assistant",
      "user",
      "user",
    ])
  })

  it("实际落点必在有损矩阵里声明；矩阵无死条目", () => {
    const events = [
      ev("core.user_message", { content: [{ type: "text", text: "hi" }] }),
      ev("core.model_thinking", { text: "a" }, { replay: { ...ORIGIN, thinkingSignature: "s" } }),
      ev("core.model_thinking", { text: "b" }),
      ev("core.model_text", { text: "x" }),
      ev("core.model_text", { text: "y" }),
      ev("core.tool_call", { toolCallId: "c1", name: "t", args: {} }),
      ev("core.user_message", { content: [{ type: "text", text: "插话（后移）" }] }),
      ev(
        "core.tool_result",
        { toolCallId: "c1", name: "t", content: [{ type: "text", text: "ok" }], isError: false },
        { actor: "tool" },
      ),
      ev(
        "core.tool_result",
        { toolCallId: "c1", name: "t", content: [{ type: "text", text: "no" }], isError: true },
        { actor: "tool" },
      ),
      ev("core.system_note", { kind: "pin", text: "p" }, { actor: "system" }),
      ev(
        "core.compaction",
        { coversSeq: [1, 2], summary: "s", decidedBy: "threshold", pinsKept: [] },
        { actor: "system" },
      ),
      ev(
        "core.budget_usage",
        { tokens: { input: 1, output: 1 }, toolCalls: 0, wallMs: 1 },
        { actor: "system" },
      ),
      ev("core.model_text", { text: "single" }),
    ]
    const { landings } = toModelMessages(events, { model: MODEL })
    const seen = new Set<string>()
    for (const l of landings) {
      const declared = TANSTACK_LOSS_MATRIX[l.type]
      expect(declared, l.type).toBeDefined()
      expect(
        declared?.some((d) => d.kind === l.kind && d.landing === l.landing),
        `${l.type} → ${l.kind}/${l.landing}`,
      ).toBe(true)
      seen.add(`${l.type}|${l.kind}|${l.landing}`)
    }
    for (const [type, entries] of Object.entries(TANSTACK_LOSS_MATRIX)) {
      if (
        type.startsWith("core.") &&
        [
          "approval_request",
          "approval_decision",
          "run_paused",
          "run_resumed",
          "memory_op",
          "handoff",
          "error",
        ].includes(type.slice(5))
      )
        continue // 运维事件同一条目，budget_usage 已代表
      for (const d of entries)
        expect(seen.has(`${type}|${d.kind}|${d.landing}`), `${type} ${d.landing} 无用例覆盖`).toBe(true)
    }
  })
})

describe("importModelMessages / trailingUserMessages", () => {
  it("客户端历史整段导入：thinking 签名进 replay、工具名反查、error 记 isError", () => {
    const { drafts, dropped } = importModelMessages(
      [
        { role: "user", content: "算" },
        {
          role: "assistant",
          content: null,
          thinking: [{ content: "想", signature: "sig" }],
          toolCalls: [{ id: "c1", type: "function", function: { name: "add", arguments: '{"a":1}' } }],
        },
        { role: "tool", toolCallId: "c1", content: "oops", error: "oops" },
        { role: "assistant", content: "答" },
        {
          role: "user",
          content: [
            { type: "text", content: "再来" },
            { type: "audio", source: { type: "url", value: "x" } },
          ],
        },
      ],
      ORIGIN,
    )
    expect(drafts.map((d) => d.type.replace("core.", ""))).toEqual([
      "user_message",
      "model_thinking",
      "tool_call",
      "tool_result",
      "model_text",
      "user_message",
    ])
    expect(drafts[1]?.replay).toEqual({ ...ORIGIN, thinkingSignature: "sig" })
    expect(drafts[2]?.payload).toEqual({ toolCallId: "c1", name: "add", args: { a: 1 } })
    expect(drafts[3]?.payload).toMatchObject({ name: "add", isError: true })
    expect(dropped).toEqual(["audio"])
    expect(drafts[5]?.payload).toEqual({
      content: [
        { type: "text", text: "再来" },
        { type: "text", text: "[audio 片段未能导入 reins 时间线]" },
      ],
    })
  })

  it("末尾连续的 user 消息是新输入", () => {
    const tail = trailingUserMessages([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "user", content: "d" },
    ])
    expect(tail.map((m) => m.content)).toEqual(["c", "d"])
    expect(
      trailingUserMessages([
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ]),
    ).toEqual([])
  })
})

describe("BlockAssembler", () => {
  it("思考签名排在 END 之后仍能挂上；文本两段 delta 拼成一块；工具入参解析不了原样存", () => {
    const a = new BlockAssembler(ORIGIN)
    const out = [
      ...a.push({ type: "REASONING_MESSAGE_START", messageId: "r", role: "reasoning" } as never),
      ...a.push({ type: "REASONING_MESSAGE_CONTENT", messageId: "r", delta: "想想" } as never),
      ...a.push({ type: "REASONING_MESSAGE_END", messageId: "r" } as never),
      ...a.push({
        type: "REASONING_ENCRYPTED_VALUE",
        subtype: "message",
        entityId: "r",
        encryptedValue: "SIG",
      } as never),
      ...a.push({ type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" } as never),
      ...a.push({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "你" } as never),
      ...a.push({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "好" } as never),
      ...a.push({ type: "TEXT_MESSAGE_END", messageId: "m" } as never),
      ...a.push({ type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "t" } as never),
      ...a.push({ type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: "{not json" } as never),
      ...a.push({ type: "TOOL_CALL_END", toolCallId: "c1" } as never),
      ...a.push({ type: "RUN_FINISHED", threadId: "t", runId: "r" } as never),
    ]
    expect(out).toEqual([
      {
        type: "core.model_thinking",
        actor: "model",
        payload: { text: "想想" },
        replay: { ...ORIGIN, thinkingSignature: "SIG" },
      },
      { type: "core.model_text", actor: "model", payload: { text: "你好" }, replay: ORIGIN },
      {
        type: "core.tool_call",
        actor: "model",
        payload: { toolCallId: "c1", name: "t", args: "{not json" },
        replay: ORIGIN,
      },
    ])
  })
})

describe("toModelMessages：用户消息后移", () => {
  it("工具结果没到齐时用户插话：消息后移到同批结果之后，落点记 lossy", () => {
    const events = [
      ev("core.user_message", { content: [{ type: "text", text: "go" }] }),
      ev("core.tool_call", { toolCallId: "c1", name: "t", args: {} }),
      ev("core.user_message", { content: [{ type: "text", text: "顺便" }] }),
      ev(
        "core.tool_result",
        { toolCallId: "c1", name: "t", content: [{ type: "text", text: "r" }], isError: false },
        { actor: "tool" },
      ),
      ev("core.model_text", { text: "ok" }),
    ]
    const { messages, landings } = toModelMessages(events, { model: MODEL })
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "assistant"])
    const late = landings.find((l) => l.eventId === events[2]?.id)
    expect(late).toMatchObject({ kind: "lossy", landing: "user" })
  })
})
