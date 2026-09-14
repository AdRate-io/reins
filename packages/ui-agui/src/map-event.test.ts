import { EventSchemas } from "@ag-ui/core"
import {
  CORE_SCHEMAS,
  type CoreEventPayloads,
  type CoreEventType,
  createCoreEvent,
  createCoreRegistry,
  createEvent,
  type Event,
} from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import { AGUI_MAPPING, mapEvent, partsToText } from "./map-event.js"
import type { AguiEvent } from "./types.js"

const registry = createCoreRegistry()
const SESSION = "s1"

function ev<T extends CoreEventType>(type: T, payload: CoreEventPayloads[T], seq = 1): Event {
  const actor = type.startsWith("core.model") ? "model" : type === "core.user_message" ? "user" : "system"
  return createCoreEvent(registry, {
    type,
    payload,
    actor,
    sessionId: SESSION,
    seq,
    at: 1_800_000_000_000,
    id: `e${seq}`,
  })
}

/** 每种内置事件一个代表样本（正文非空，走映射表的完整形态） */
const SAMPLES: { [T in CoreEventType]: CoreEventPayloads[T] } = {
  "core.user_message": { content: [{ type: "text", text: "你好" }] },
  "core.model_text": { text: "你好，有什么可以帮你" },
  "core.model_thinking": { text: "用户在打招呼" },
  "core.tool_call": { toolCallId: "c1", name: "add", args: { a: 1, b: 2 } },
  "core.tool_result": {
    toolCallId: "c1",
    name: "add",
    content: [{ type: "text", text: "3" }],
    isError: false,
  },
  "core.system_note": { kind: "perception", text: "上下文用了 12%" },
  "core.approval_request": { toolCallId: "c2", policyId: "tool.needsApproval", summary: "上线 prod" },
  "core.approval_decision": { toolCallId: "c2", approved: true, by: "boss" },
  "core.compaction": { coversSeq: [1, 8], summary: "前面聊了天气", decidedBy: "model", pinsKept: [] },
  "core.handoff": { toSessionId: "s2", summary: "接着做", reason: "上下文太长" },
  "core.memory_op": { op: "create", path: "/memories/a.md", bytes: 12 },
  "core.budget_usage": { tokens: { input: 10, output: 5 }, toolCalls: 1, wallMs: 20 },
  "core.run_paused": { reason: "approval" },
  "core.run_resumed": { by: "boss" },
  "core.tools_bound": { toolNames: ["add", "compact"], configHash: "abc" },
  "core.error": { category: "provider", message: "超时", retryable: true },
}

/** 官方 schema 逐条校验：我们手抄的形状若与 @ag-ui/core 不一致，这里会红 */
function assertValidAgui(events: readonly AguiEvent[]) {
  for (const e of events) {
    const parsed = EventSchemas.safeParse(e)
    expect(
      parsed.success,
      `${e.type} 不符合 AG-UI schema：${JSON.stringify(parsed.success ? "" : parsed.error.issues)}`,
    ).toBe(true)
  }
}

describe("映射表：每种时间线事件 → AG-UI 事件", () => {
  for (const type of Object.keys(SAMPLES) as CoreEventType[]) {
    it(`${type} → ${AGUI_MAPPING[type].join(" → ")}`, () => {
      const out = mapEvent(ev(type, SAMPLES[type]))
      expect(out.map((e) => e.type)).toEqual(AGUI_MAPPING[type])
      assertValidAgui(out)
      // 每条翻出来的事件都标了来源 seq / id / type，前端能对回时间线
      for (const e of out) {
        expect(e.metadata?.reins).toMatchObject({ seq: 1, eventId: "e1", type })
        expect(e.timestamp).toBe(1_800_000_000_000)
      }
    })
  }

  it("ext.* → CUSTOM，name 就是事件 type，value 是事件本身", () => {
    const reg = createCoreRegistry([{ type: "ext.metric", version: 1 }])
    const e = createEvent(reg, {
      type: "ext.metric",
      payload: { n: 1 },
      actor: "host",
      sessionId: SESSION,
      seq: 3,
      at: 1,
      id: "x",
    })
    const out = mapEvent(e)
    expect(out.map((o) => o.type)).toEqual(AGUI_MAPPING["ext.*"])
    expect(out[0]).toMatchObject({ type: "CUSTOM", name: "ext.metric", value: e })
    assertValidAgui(out)
  })

  it("映射表没有死条目：每个键都是内置事件类型或 ext.*", () => {
    const known = new Set<string>([...CORE_SCHEMAS.map((s) => s.type), "ext.*"])
    for (const key of Object.keys(AGUI_MAPPING)) expect(known.has(key), key).toBe(true)
    expect(Object.keys(AGUI_MAPPING).length).toBe(CORE_SCHEMAS.length + 1)
  })
})

describe("字段细节", () => {
  it("user_message：role user、messageId = 事件 id、正文合并；图片以占位符代替并在 dropped 声明", () => {
    const out = mapEvent(
      ev("core.user_message", {
        content: [
          { type: "text", text: "看图" },
          { type: "image", mime: "image/png", data: "AAAA" },
        ],
      }),
    )
    expect(out[0]).toMatchObject({ type: "TEXT_MESSAGE_START", messageId: "e1", role: "user" })
    expect(out[1]).toMatchObject({ type: "TEXT_MESSAGE_CONTENT", delta: "看图\n[图片 image/png]" })
    expect(out[0]?.metadata?.reins).toMatchObject({ dropped: ["image:image/png"] })
    expect(partsToText([])).toEqual({ text: "", dropped: [] })
  })

  it("model_text 空正文：没有 CONTENT（AG-UI 不允许空 delta），只有 START / END", () => {
    const out = mapEvent(ev("core.model_text", { text: "" }))
    expect(out.map((e) => e.type)).toEqual(["TEXT_MESSAGE_START", "TEXT_MESSAGE_END"])
    assertValidAgui(out)
  })

  it("model_thinking 只有 replay 没正文（加密 reasoning）：只有 REASONING_START / END", () => {
    const out = mapEvent(ev("core.model_thinking", { text: "" }))
    expect(out.map((e) => e.type)).toEqual(["REASONING_START", "REASONING_END"])
    assertValidAgui(out)
  })

  it("tool_call：入参整段 JSON 放 ARGS；给了 parentMessageId 就挂上", () => {
    const out = mapEvent(ev("core.tool_call", SAMPLES["core.tool_call"]), { parentMessageId: "m1" })
    expect(out[0]).toMatchObject({
      type: "TOOL_CALL_START",
      toolCallId: "c1",
      toolCallName: "add",
      parentMessageId: "m1",
    })
    expect(out[1]).toMatchObject({ type: "TOOL_CALL_ARGS", delta: '{"a":1,"b":2}' })
    expect(out[2]).toMatchObject({ type: "TOOL_CALL_END", toolCallId: "c1" })
    const bare = mapEvent(ev("core.tool_call", SAMPLES["core.tool_call"]))
    expect("parentMessageId" in (bare[0] as object)).toBe(false)
  })

  it("tool_result：role tool、isError 与 spilled 进 metadata.reins", () => {
    const out = mapEvent(
      ev("core.tool_result", {
        toolCallId: "c1",
        name: "fetch",
        content: [{ type: "text", text: "太大，已外溢" }],
        isError: true,
        spilled: { blobId: "b1", summary: "12MB HTML" },
      }),
    )
    expect(out[0]).toMatchObject({
      type: "TOOL_CALL_RESULT",
      messageId: "e1",
      toolCallId: "c1",
      content: "太大，已外溢",
      role: "tool",
      metadata: { reins: { isError: true, spilled: { blobId: "b1", summary: "12MB HTML" } } },
    })
    assertValidAgui(out)
  })

  it("approval_request → CUSTOM 带完整事件，前端据此弹窗", () => {
    const e = ev("core.approval_request", SAMPLES["core.approval_request"], 7)
    const out = mapEvent(e)
    expect(out[0]).toMatchObject({ type: "CUSTOM", name: "core.approval_request", value: e })
  })
})

describe("工具定义引用段（L1）", () => {
  it("partsToText 把引用段展开成文本，不算 dropped", () => {
    const out = partsToText([
      { type: "tool_reference", name: "g", description: "dg", inputSchema: { type: "object" } },
    ])
    expect(out).toEqual({ text: '### g\ndg\nInput schema: {"type":"object"}', dropped: [] })
  })
})
