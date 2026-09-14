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
