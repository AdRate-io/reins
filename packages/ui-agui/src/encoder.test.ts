import { EventSchemas } from "@ag-ui/core"
import {
  type CoreEventPayloads,
  type CoreEventType,
  createCoreEvent,
  createCoreRegistry,
  defineTool,
  type Event,
  InMemoryEventLog,
  type RunResult,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, say, think } from "@reinsjs/core/testing"
import { createAgentHandler, type SseFrame, type StreamItem } from "@reinsjs/server"
import { describe, expect, it } from "vitest"
import { aguiEncoding, createAguiEncoder } from "./encoder.js"
import type { AguiEvent } from "./types.js"

const registry = createCoreRegistry()

function ev<T extends CoreEventType>(type: T, payload: CoreEventPayloads[T], seq: number): Event {
  const actor = type.startsWith("core.model") ? "model" : type === "core.user_message" ? "user" : "system"
  return createCoreEvent(registry, {
    type,
    payload,
    actor,
    sessionId: "s1",
    seq,
    at: 1_800_000_000_000 + seq,
    id: `e${seq}`,
  })
}

/** 确定性 id：run 用 r1、r2…，增量开出的消息用 m1、m2… */
function encoder() {
  let r = 0
  let m = 0
  return createAguiEncoder({ newRunId: () => `r${++r}`, newMessageId: () => `m${++m}` })
}

const start: StreamItem = { kind: "start", sessionId: "s1", fromSeq: 1, live: true }
const delta = (kind: "text" | "thinking" | "tool_args", index: number, d: string): StreamItem => ({
  kind: "delta",
  delta: { kind, index, delta: d },
})
const item = (e: Event): StreamItem => ({ kind: "event", event: e, replay: false })
const done: StreamItem = { kind: "result", result: { status: "done", sessionId: "s1", lastSeq: 9 } }

function feed(items: StreamItem[]): SseFrame[] {
  const enc = encoder()
  return items.flatMap((i) => enc(i))
}
const data = (frames: readonly SseFrame[]) => frames.map((f) => f.data as AguiEvent)
const types = (frames: readonly SseFrame[]) => data(frames).map((e) => e.type)

function assertValidAgui(frames: readonly SseFrame[]) {
  for (const e of data(frames)) {
    const parsed = EventSchemas.safeParse(e)
    expect(parsed.success, `${e.type}：${JSON.stringify(parsed.success ? "" : parsed.error.issues)}`).toBe(
      true,
    )
  }
  assertAguiSequence(data(frames))
}

/**
 * 帧序合法性，照 @ag-ui/client 1.0.3 verifyEvents 的规则手抄：文本消息 / 思考跨度 / 思考消息 / 工具调用各按 id 跟踪，
 * 同 id 不能重复 START，CONTENT / END 必须在打开状态，RUN_FINISHED 时四类都必须已收尾；不同 id 允许同时打开
 */
function assertAguiSequence(events: readonly AguiEvent[]) {
  const active = {
    text: new Set<string>(),
    span: new Set<string>(),
    reasoning: new Set<string>(),
    tool: new Set<string>(),
  }
  const opens: Partial<Record<string, [keyof typeof active, "start" | "in" | "end"]>> = {
    TEXT_MESSAGE_START: ["text", "start"],
    TEXT_MESSAGE_CONTENT: ["text", "in"],
    TEXT_MESSAGE_END: ["text", "end"],
    REASONING_START: ["span", "start"],
    REASONING_END: ["span", "end"],
    REASONING_MESSAGE_START: ["reasoning", "start"],
    REASONING_MESSAGE_CONTENT: ["reasoning", "in"],
    REASONING_MESSAGE_END: ["reasoning", "end"],
    TOOL_CALL_START: ["tool", "start"],
    TOOL_CALL_ARGS: ["tool", "in"],
    TOOL_CALL_END: ["tool", "end"],
  }
  events.forEach((e, i) => {
    const where = `#${i} ${e.type}`
    if (e.type === "RUN_FINISHED") {
      for (const [k, set] of Object.entries(active)) expect([...set], `${where}：${k} 未收尾`).toEqual([])
      return
    }
    const rule = opens[e.type]
    if (!rule) return
    const [k, op] = rule
    const id = "toolCallId" in e ? e.toolCallId : "messageId" in e ? e.messageId : ""
    const set = active[k]
    if (op === "start") {
      expect(set.has(id), `${where}：${id} 已在进行中`).toBe(false)
      set.add(id)
    } else {
      expect(set.has(id), `${where}：${id} 没有打开`).toBe(true)
      if (op === "end") set.delete(id)
    }
  })
}

describe("流式增量与完整事件接成同一条消息", () => {
  it("文本：首片开 START，逐片 CONTENT，完整 model_text 只补 END；seq 挂在最后一帧", () => {
    const frames = feed([
      start,
      delta("text", 0, "答案"),
      delta("text", 0, "是 5"),
      item(ev("core.model_text", { text: "答案是 5" }, 3)),
      done,
    ])
    expect(types(frames)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ])
    const ids = new Set(data(frames.slice(1, 5)).map((e) => (e as { messageId: string }).messageId))
    expect(ids).toEqual(new Set(["m1"]))
    expect(data(frames)[2]).toMatchObject({ delta: "答案" })
    expect(data(frames)[3]).toMatchObject({ delta: "是 5" })
    // 完整事件没有再吐一遍正文，但 END 上有来源 seq，SSE id 也是它
    expect(data(frames)[4]).toMatchObject({ type: "TEXT_MESSAGE_END", metadata: { reins: { seq: 3 } } })
    expect(frames[4]?.id).toBe("3")
    expect(frames.filter((f) => f.id !== undefined)).toHaveLength(1)
    expect(data(frames)[0]).toMatchObject({ type: "RUN_STARTED", threadId: "s1", runId: "r1" })
    expect(data(frames).at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      runId: "r1",
      outcome: { type: "success" },
    })
    assertValidAgui(frames)
  })

  it("思考：REASONING 五件套跨增量与完整事件；随后的 tool_call 挂在同轮 assistant 文本上", () => {
    const frames = feed([
      start,
      delta("thinking", 0, "先算"),
      item(ev("core.model_thinking", { text: "先算" }, 2)),
      delta("text", 1, "我来算"),
      item(ev("core.model_text", { text: "我来算" }, 3)),
      delta("tool_args", 2, '{"a":'),
      item(ev("core.tool_call", { toolCallId: "c1", name: "add", args: { a: 1, b: 2 } }, 4)),
      done,
    ])
    expect(types(frames)).toEqual([
      "RUN_STARTED",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "RUN_FINISHED",
    ])
    expect(data(frames)[9]).toMatchObject({ type: "TOOL_CALL_START", parentMessageId: "m2" })
    // tool_args 增量丢弃：入参在完整 tool_call 到达时一次给出
    expect(data(frames)[10]).toMatchObject({ type: "TOOL_CALL_ARGS", delta: '{"a":1,"b":2}' })
    assertValidAgui(frames)
  })

  it("真实降级层节奏：思考与正文都流完才依次提交，每段只有一组 START/CONTENT/END，END 带 metadata（AdRate 建议 9）", () => {
    const frames = feed([
      start,
      delta("thinking", 0, "The"),
      delta("thinking", 0, " user"),
      delta("text", 1, "我"),
      delta("text", 1, "来查"),
      delta("tool_args", 2, '{"id":'),
      item(ev("core.model_thinking", { text: "The user" }, 13)),
      item(ev("core.model_text", { text: "我来查" }, 14)),
      item(ev("core.tool_call", { toolCallId: "c1", name: "get", args: { id: 1 } }, 15)),
      done,
    ])
    expect(types(frames)).toEqual([
      "RUN_STARTED",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_CONTENT",
      "TEXT_MESSAGE_START", // 思考块仍开着：它的完整事件还没到
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "RUN_FINISHED",
    ])
    const evs = data(frames)
    // 思考是 m1、正文是 m2，各自只出现一次 START；收尾帧带事件元数据，SSE id 挂在收尾帧上
    expect(
      evs
        .filter((e) => e.type.endsWith("_START") && e.type !== "RUN_STARTED")
        .map(
          (e) =>
            (e as { messageId?: string; toolCallId?: string }).messageId ??
            (e as { toolCallId: string }).toolCallId,
        ),
    ).toEqual(["m1", "m1", "m2", "c1"])
    expect(evs[9]).toMatchObject({
      type: "REASONING_END",
      messageId: "m1",
      metadata: { reins: { seq: 13, eventId: "e13", type: "core.model_thinking" } },
    })
    expect(evs[10]).toMatchObject({
      type: "TEXT_MESSAGE_END",
      messageId: "m2",
      metadata: { reins: { seq: 14, eventId: "e14", type: "core.model_text" } },
    })
    expect(evs[11]).toMatchObject({ type: "TOOL_CALL_START", parentMessageId: "m2" })
    expect(frames.filter((f) => f.id !== undefined).map((f) => [f.id, (f.data as AguiEvent).type])).toEqual([
      ["13", "REASONING_END"],
      ["14", "TEXT_MESSAGE_END"],
      ["15", "TOOL_CALL_END"],
    ])
    assertValidAgui(frames)
  })

  it("同一 kind 多块（index 不同）按打开顺序各自认领；没流过增量的空思考（加密 / redacted）不抢认领", () => {
    const frames = feed([
      start,
      delta("thinking", 1, "想一"),
      delta("text", 2, "第一段"),
      delta("thinking", 3, "想二"),
      delta("text", 4, "第二段"),
      item(ev("core.model_thinking", { text: "" }, 2)),
      item(ev("core.model_thinking", { text: "想一" }, 3)),
      item(ev("core.model_text", { text: "第一段" }, 4)),
      item(ev("core.model_thinking", { text: "想二" }, 5)),
      item(ev("core.model_text", { text: "第二段" }, 6)),
      done,
    ])
    const evs = data(frames)
    const ends = evs.filter((e) => e.type === "REASONING_END" || e.type === "TEXT_MESSAGE_END")
    expect(
      ends.map((e) => [
        (e as { messageId: string }).messageId,
        (e.metadata as { reins?: { seq: number } } | undefined)?.reins?.seq,
      ]),
    ).toEqual([
      ["e2", 2], // 空思考走完整翻译，用事件 id，不碰 m1
      ["m1", 3],
      ["m2", 4],
      ["m3", 5],
      ["m4", 6],
    ])
    // 内容只经增量出现一次，提交时不再重发
    expect(
      evs.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => (e as { delta: string }).delta),
    ).toEqual(["第一段", "第二段"])
    assertValidAgui(frames)
  })

  it("按内容认领：redacted 思考（占位正文）不抢后面流过的块；上游没给草稿的块不被错认；首尾空白不算", () => {
    const frames = feed([
      start,
      delta("thinking", 1, "真正的思考"),
      delta("thinking", 1, "\n\n"), // pi-ai Responses 线每段摘要后多发的空行，收尾正文不带
      delta("text", 2, "甲"), // 这块上游没给草稿
      delta("text", 3, "乙"),
      item(ev("core.model_thinking", { text: "[Reasoning redacted]" }, 2)),
      item(ev("core.model_thinking", { text: "真正的思考" }, 3)),
      item(ev("core.model_text", { text: "乙" }, 4)),
      done,
    ])
    const evs = data(frames)
    const ends = evs
      .filter((e) => e.type === "REASONING_END" || e.type === "TEXT_MESSAGE_END")
      .map((e) => [
        (e as { messageId: string }).messageId,
        (e.metadata as { reins?: { seq: number } } | undefined)?.reins?.seq,
      ])
    expect(ends).toEqual([
      ["e2", 2], // redacted 走完整翻译
      ["m1", 3],
      ["m3", 4], // "乙" 认领 m3，不是更早打开的 m2
      ["m2", undefined], // "甲" 没人认领，run 结束时无主收尾
    ])
    // 流过的正文各只出现一次
    const contents = evs
      .filter((e) => e.type === "REASONING_MESSAGE_CONTENT" || e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => (e as { delta: string }).delta)
    expect(contents.filter((c) => c === "真正的思考")).toHaveLength(1)
    expect(contents.filter((c) => c === "乙")).toHaveLength(1)
    assertValidAgui(frames)
  })

  it("内容对不上（只流到后半截）：不认领、整段照发，宁可重复也不丢内容", () => {
    const frames = feed([
      start,
      delta("thinking", 0, "后半"),
      item(ev("core.model_thinking", { text: "前半后半" }, 13)),
      done,
    ])
    const evs = data(frames)
    expect(evs.find((e) => e.type === "REASONING_MESSAGE_CONTENT" && e.messageId === "e13")).toMatchObject({
      delta: "前半后半",
    })
    expect(
      evs.filter((e) => e.type === "REASONING_END").map((e) => (e as { messageId: string }).messageId),
    ).toEqual(["e13", "m1"])
    assertValidAgui(frames)
  })

  it("没被认领的块：遇到非模型输出的事件或 run 结束时无主收尾，不留半截", () => {
    const frames = feed([
      start,
      delta("thinking", 0, "想到一半"),
      delta("text", 1, "说到一半"),
      item(ev("core.error", { category: "provider", message: "boom", retryable: false }, 2)),
      delta("text", 0, "新一轮"),
      done,
    ])
    expect(types(frames)).toEqual([
      "RUN_STARTED",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "TEXT_MESSAGE_END",
      "CUSTOM",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ])
    // 无主收尾不带 metadata：它们没有对应的时间线事件
    expect(
      data(frames)
        .filter((e) => e.type.endsWith("_END"))
        .every((e) => e.metadata === undefined),
    ).toBe(true)
    assertValidAgui(frames)
  })

  it("没有增量（补发路径）：完整事件直接用事件 id 做 messageId；用户说话后 tool_call 不再挂旧父消息", () => {
    const frames = feed([
      { kind: "start", sessionId: "s1", fromSeq: 1, live: false },
      item(ev("core.user_message", { content: [{ type: "text", text: "1+2" }] }, 1)),
      item(ev("core.model_text", { text: "算一下" }, 2)),
      item(ev("core.tool_call", { toolCallId: "c1", name: "add", args: {} }, 3)),
      item(ev("core.user_message", { content: [{ type: "text", text: "再来" }] }, 4)),
      item(ev("core.tool_call", { toolCallId: "c2", name: "add", args: {} }, 5)),
      { kind: "end", sessionId: "s1", lastSeq: 5 },
    ])
    const evs = data(frames)
    expect(evs[1]).toMatchObject({ type: "TEXT_MESSAGE_START", messageId: "e1", role: "user" })
    expect(evs[4]).toMatchObject({ type: "TEXT_MESSAGE_START", messageId: "e2", role: "assistant" })
    expect(evs[7]).toMatchObject({ type: "TOOL_CALL_START", toolCallId: "c1", parentMessageId: "e2" })
    const c2 = evs.find((e) => e.type === "TOOL_CALL_START" && e.toolCallId === "c2")
    expect(c2 && "parentMessageId" in c2).toBe(false)
    expect(evs.at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      result: { status: "replayed", lastSeq: 5 },
      outcome: { type: "success" },
    })
    // 每个时间线事件恰好一帧带 id
    expect(frames.filter((f) => f.id !== undefined).map((f) => f.id)).toEqual(["1", "2", "3", "4", "5"])
    assertValidAgui(frames)
  })

  it("补发结束带续跑状态：原样进 RUN_FINISHED(replayed).result.state，outcome 仍是 success（AdRate 建议 8）", () => {
    const state = {
      v: 1 as const,
      sessionId: "s1",
      lastSeq: 2,
      pendingToolCallIds: ["c1"],
      configHash: "h",
      pendingDigest: "d",
      sig: "x",
    }
    const frames = feed([start, { kind: "end", sessionId: "s1", lastSeq: 2, state }])
    expect(data(frames).at(-1)).toEqual({
      type: "RUN_FINISHED",
      threadId: "s1",
      runId: expect.any(String),
      result: { status: "replayed", sessionId: "s1", lastSeq: 2, state },
      outcome: { type: "success" },
    })
    assertValidAgui(frames)
    // 不带 state 时 result 里也没有这个键
    const plain = data(feed([start, { kind: "end", sessionId: "s1", lastSeq: 2 }])).at(-1) as {
      result: Record<string, unknown>
    }
    expect("state" in plain.result).toBe(false)
  })

  it("半截块遇到别的事件先到：先收尾再翻译，不留没有 END 的消息", () => {
    const frames = feed([
      start,
      delta("text", 0, "先说一半"),
      item(ev("core.system_note", { kind: "budget", text: "快满了" }, 2)),
      done,
    ])
    expect(types(frames)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "CUSTOM",
      "RUN_FINISHED",
    ])
    assertValidAgui(frames)
  })
})

describe("run 结束的三种翻译", () => {
  it("paused → RUN_FINISHED(interrupt)，中断项一一对应；state 原样放 result 供前端回传", () => {
    const paused: RunResult = {
      status: "paused",
      sessionId: "s1",
      lastSeq: 5,
      reason: "approval",
      interruptions: [
        {
          kind: "approval",
          toolCallId: "c1",
          request: { toolCallId: "c1", policyId: "tool.needsApproval", summary: "上线 prod" },
          call: { toolCallId: "c1", name: "deploy", args: { env: "prod" } },
        },
        { kind: "client_tool", toolCallId: "c2", call: { toolCallId: "c2", name: "pick_file", args: {} } },
        { kind: "budget", note: "轮数到顶" },
        // 子代理冒泡（§10.1）：子的中断与状态嵌进 metadata
        {
          kind: "subagent",
          toolCallId: "c3",
          call: { toolCallId: "c3", name: "ask_expert", args: { task: "t" } },
          childSessionId: "s1:c3",
          reason: "approval",
          interruptions: [
            {
              kind: "approval",
              toolCallId: "k1",
              request: { toolCallId: "k1", policyId: "p", summary: "deploy()" },
              call: { toolCallId: "k1", name: "deploy", args: {} },
            },
          ],
          state: {
            v: 1,
            sessionId: "s1:c3",
            lastSeq: 4,
            pendingToolCallIds: ["k1"],
            configHash: "h2",
            pendingDigest: "d2",
          },
        },
      ],
      state: {
        v: 1,
        sessionId: "s1",
        lastSeq: 5,
        pendingToolCallIds: ["c1", "c2", "c3"],
        configHash: "h",
        pendingDigest: "d",
      },
    }
    const frames = feed([start, { kind: "result", result: paused }])
    const fin = data(frames)[1]
    expect(fin).toMatchObject({
      type: "RUN_FINISHED",
      result: paused,
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "c1",
            reason: "approval",
            message: "上线 prod",
            toolCallId: "c1",
            metadata: { policyId: "tool.needsApproval" },
          },
          { id: "c2", reason: "client_tool", toolCallId: "c2" },
          { id: "budget:5:2", reason: "budget", message: "轮数到顶" },
          {
            id: "c3",
            reason: "subagent",
            message: "subagent session s1:c3 paused (approval)",
            toolCallId: "c3",
            metadata: {
              childSessionId: "s1:c3",
              childReason: "approval",
              interruptions: [{ kind: "approval", toolCallId: "k1" }],
            },
          },
        ],
      },
    })
    assertValidAgui(frames)
  })

  it("error 态与 error 项 → RUN_ERROR", () => {
    const error = ev("core.error", { category: "provider", message: "上游 500", retryable: true }, 4)
    const a = feed([
      start,
      { kind: "result", result: { status: "error", sessionId: "s1", lastSeq: 4, error } as RunResult },
    ])
    expect(data(a)[1]).toEqual({ type: "RUN_ERROR", message: "上游 500", code: "provider" })
    const b = feed([start, { kind: "error", code: "bad_signature", message: "签名不对" }])
    expect(data(b)[1]).toEqual({ type: "RUN_ERROR", message: "签名不对", code: "bad_signature" })
    assertValidAgui([...a, ...b])
  })

  it("handoff → success，result 带 toSessionId", () => {
    const frames = feed([
      start,
      { kind: "result", result: { status: "handoff", sessionId: "s1", lastSeq: 9, toSessionId: "s2" } },
    ])
    expect(data(frames)[1]).toMatchObject({
      type: "RUN_FINISHED",
      outcome: { type: "success" },
      result: { toSessionId: "s2" },
    })
    assertValidAgui(frames)
  })
})

describe("接上 @reinsjs/server", () => {
  const addTool = defineTool<{ a: number; b: number }>({
    name: "add",
    // 纯计算、只读：可重放，不写 tool_started
    risk: "low",
    description: "两数相加",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
    execute: ({ a, b }) => a + b,
  })

  function parseSse(text: string): SseFrame[] {
    return text
      .split("\n\n")
      .filter((b) => b.trim() !== "")
      .map((block) => {
        const frame: SseFrame = { data: undefined }
        for (const line of block.split("\n")) {
          if (line.startsWith("id: ")) frame.id = line.slice(4)
          else if (line.startsWith("event: ")) frame.event = line.slice(7)
          else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6))
        }
        return frame
      })
  }

  it("整条流都是合法 AG-UI 事件：RUN_STARTED 开头、RUN_FINISHED 结尾、增量与完整事件接得上、无 event 名", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [think("先算"), callTool("c1", "add", { a: 2, b: 3 })] },
      { drafts: [say("答案是 5")] },
    ])
    let r = 0
    const handler = createAgentHandler(
      { log, lowering, model: { provider: "scripted", id: "scripted" }, tools: [addTool] },
      { heartbeatMs: 0, encode: aguiEncoding({ newRunId: () => `run${++r}`, newMessageId: () => `m${r}` }) },
    )
    const res = await handler(
      new Request("http://t/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", input: "2+3" }),
      }),
    )
    const frames = parseSse(await res.text())
    assertValidAgui(frames)
    expect(frames.every((f) => f.event === undefined)).toBe(true)
    expect(types(frames)).toEqual([
      "RUN_STARTED",
      "CUSTOM", // tools_bound：runLoop 起步落的工具表快照（模型不可见，但会翻成 AG-UI CUSTOM）
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "CUSTOM", // budget_usage
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT", // 增量
      "TEXT_MESSAGE_END", // 完整 model_text 只补 END
      "CUSTOM",
      "RUN_FINISHED",
    ])
    // ScriptedLowering 的文本增量与完整事件接成一条：CONTENT 只有一次，id 一致
    const text = data(frames).filter(
      (e) => e.type.startsWith("TEXT_MESSAGE") && "messageId" in e && e.messageId === "m1",
    )
    expect(text.map((e) => e.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
    ])
    // 多了起步的 tools_bound，日志共 8 条事件，帧 id 逐一对上 seq
    expect(frames.filter((f) => f.id !== undefined).map((f) => f.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
    ])

    // 第二条流：新的 run id、状态不串（补发 8 条 + 结束）
    const again = await handler(new Request("http://t/agent?sessionId=s1"))
    const replay = parseSse(await again.text())
    expect(data(replay)[0]).toMatchObject({ type: "RUN_STARTED", runId: "run2" })
    expect(data(replay).at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      runId: "run2",
      result: { status: "replayed", lastSeq: 8 },
    })
    assertValidAgui(replay)
  })
})
