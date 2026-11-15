/**
 * 会话运行状态（AdRate 建议 11 / 12）：终结事件不变式、awaiting / stopped、runStatusOf 分类。
 * 机制正确性，全部假模型。
 */
import { describe, expect, it } from "vitest"
import type { Event } from "../events/base.js"
import type {
  AwaitingCall,
  CoreEvent,
  CoreEventOf,
  CoreEventPayloads,
  CoreEventType,
} from "../events/core.js"
import { createCoreEvent } from "../events/create.js"
import { createCoreRegistry } from "../events/registry.js"
import { InMemoryEventLog } from "../store/in-memory.js"
import { callTool, ScriptedLowering, type ScriptedTurn, say } from "../testing/scripted-lowering.js"
import { runLoop } from "./run-loop.js"
import { awaitingOf, lastRunMarker, RUN_MARKER_TYPES, runStatusOf } from "./run-status.js"
import { pendingToolCalls } from "./state.js"
import { RunStop } from "./stop.js"
import { subagentPause } from "./subagent.js"
import { defineTool, isClientTool } from "./tools.js"
import type { LoopConfig, RunResult, Tool } from "./types.js"

const registry = createCoreRegistry()
const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"

function deterministic() {
  let t = 1_800_000_000_000
  let n = 0
  return { now: () => ++t, newId: () => `id${++n}` }
}

const echo = defineTool<Record<string, never>>({
  name: "echo",
  risk: "low",
  description: "",
  inputSchema: {},
  execute: () => "ok",
})
const deploy = defineTool<Record<string, never>>({
  name: "deploy",
  description: "",
  inputSchema: {},
  needsApproval: true,
  execute: () => "deployed",
})
const pick = defineTool<Record<string, never>>({
  name: "pick",
  description: "",
  inputSchema: {},
  side: "client",
})

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<RunResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

async function all(log: InMemoryEventLog, sessionId = SESSION): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(sessionId)) out.push(e as CoreEvent)
  return out
}

/** 跑一个 run，返回结果与本 run 新写的事件 */
async function runOnce(
  log: InMemoryEventLog,
  script: ScriptedTurn[],
  extra: Partial<LoopConfig> = {},
): Promise<{ result: RunResult; added: CoreEvent[] }> {
  const before = (await all(log)).length
  const result = await drain(
    runLoop({
      sessionId: SESSION,
      log,
      lowering: new ScriptedLowering(script),
      model: MODEL,
      tools: [echo, deploy, pick],
      ...deterministic(),
      ...extra,
    }),
  )
  return { result, added: (await all(log)).slice(before) }
}

const TERMINAL = new Set(["core.run_paused", "core.run_ended"])

/** 不变式：本 run 末条是终结事件且只有这一条；第一条是 tools_bound(marksEnd)（起步时已中止的除外） */
function expectInvariant(added: readonly CoreEvent[], opts: { startedAborted?: boolean } = {}) {
  expect(added.filter((e) => TERMINAL.has(e.type))).toHaveLength(1)
  expect(TERMINAL.has(added.at(-1)?.type ?? "")).toBe(true)
  if (opts.startedAborted) {
    expect(added.some((e) => e.type === "core.tools_bound")).toBe(false)
  } else {
    const first = added[0] as CoreEventOf<"core.tools_bound">
    expect(first.type).toBe("core.tools_bound")
    expect(first.payload.marksEnd).toBe(true)
  }
}

const tail = (added: readonly CoreEvent[]) => added.at(-1) as CoreEvent

/** 先跑一个停在审批上的 run（deploy 等审批），返回它的状态 */
async function pausedOnApproval(log: InMemoryEventLog) {
  const first = await runOnce(log, [{ drafts: [callTool("c1", "deploy", {})] }])
  if (first.result.status !== "paused") throw new Error("expected paused")
  return first
}

describe("终结事件不变式：每个出口恰好一条终结事件", () => {
  it("done：末条 run_ended(done)，RunResult.lastSeq 就是它", async () => {
    const log = new InMemoryEventLog()
    const { result, added } = await runOnce(log, [{ drafts: [say("好")] }], { input: "hi" })
    expectInvariant(added)
    expect(tail(added)).toMatchObject({ type: "core.run_ended", payload: { status: "done" } })
    expect(result.lastSeq).toBe(tail(added).seq)
  })

  it("maxTurns 触顶暂停", async () => {
    const log = new InMemoryEventLog()
    const { result, added } = await runOnce(log, [{ drafts: [callTool("c1", "echo", {})] }], {
      input: "hi",
      maxTurns: 1,
    })
    expect(result).toMatchObject({ status: "paused", reason: "budget" })
    expectInvariant(added)
    expect(tail(added).payload).toMatchObject({ reason: "budget", awaiting: [] })
  })

  it("审批暂停 / 客户端工具暂停 / Socket 预算暂停", async () => {
    const a = await runOnce(new InMemoryEventLog(), [{ drafts: [callTool("c1", "deploy", {})] }])
    expectInvariant(a.added)
    const c = await runOnce(new InMemoryEventLog(), [{ drafts: [callTool("c1", "pick", {})] }])
    expectInvariant(c.added)
    expect(tail(c.added).payload).toMatchObject({
      reason: "host",
      awaiting: [{ kind: "client_tool", toolCallId: "c1", name: "pick" }],
    })
    const b = await runOnce(new InMemoryEventLog(), [{ drafts: [say("x")] }], {
      sockets: [{ onTurnEnd: () => ({ pause: { reason: "budget" } }) }],
    })
    expectInvariant(b.added)
    expect(tail(b.added).payload).toMatchObject({ reason: "budget", awaiting: [] })
    expect(tail(b.added).payload).not.toHaveProperty("stopped")
  })

  it("用户停止（工具批中途）与起步时已中止", async () => {
    const log = new InMemoryEventLog()
    const controller = new AbortController()
    const stopper = defineTool<Record<string, never>>({
      name: "stopper",
      risk: "low",
      description: "",
      inputSchema: {},
      execute: () => {
        controller.abort(new RunStop())
        return "ok"
      },
    })
    const mid = await runOnce(
      log,
      [{ drafts: [callTool("c1", "stopper", {}), callTool("c2", "echo", {})] }],
      {
        tools: [stopper, echo],
        signal: controller.signal,
      },
    )
    expectInvariant(mid.added)
    expect(tail(mid.added).payload).toMatchObject({ reason: "host", awaiting: [], stopped: true })

    const idle = await runOnce(new InMemoryEventLog(), [], { signal: AbortSignal.abort(new RunStop()) })
    expectInvariant(idle.added, { startedAborted: true })
  })

  it("handoff：handoff 之后在旧会话落 run_ended(handoff)，新会话只有开场", async () => {
    const log = new InMemoryEventLog()
    const { result, added } = await runOnce(log, [{ drafts: [say("交")] }], {
      input: "hi",
      sockets: [{ onTurnEnd: () => ({ handoff: { toSessionId: "s2", summary: "sum", reason: "r" } }) }],
    })
    expect(result.status).toBe("handoff")
    expectInvariant(added)
    expect(added.at(-2)?.type).toBe("core.handoff")
    expect(tail(added).payload).toEqual({ status: "handoff", toSessionId: "s2" })
    expect(result.lastSeq).toBe(tail(added).seq)
    expect(lastRunMarker(await all(log, "s2"))).toBeUndefined()
  })

  it("两处 fail()：终结 error 与 run_ended 同批（同 at、seq 连续）", async () => {
    const provider = await runOnce(
      new InMemoryEventLog(),
      [{ drafts: [], outcome: { stopReason: "error", errorMessage: "boom" } }],
      { input: "hi" },
    )
    const pulled = await runOnce(new InMemoryEventLog(), [], { input: "hi", pullInput: () => "bad" as never })
    for (const { result, added } of [provider, pulled]) {
      expect(result.status).toBe("error")
      expectInvariant(added)
      const [err, ended] = added.slice(-2) as [CoreEventOf<"core.error">, CoreEventOf<"core.run_ended">]
      expect(err.type).toBe("core.error")
      expect(ended.payload).toEqual({ status: "error", category: err.payload.category })
      expect(ended.at).toBe(err.at)
      expect(ended.seq).toBe(err.seq + 1)
    }
  })

  it("非终结 error（重试前、pullInput 抛错）后面不跟 run_ended", async () => {
    const retried = await runOnce(
      new InMemoryEventLog(),
      [{ drafts: [], throws: new Error("ECONNRESET") }, { drafts: [say("好")] }],
      { input: "hi", retry: { sleep: async () => {} } },
    )
    const thrown = await runOnce(new InMemoryEventLog(), [{ drafts: [say("好")] }], {
      input: "hi",
      pullInput: () => {
        throw new Error("db down")
      },
    })
    for (const { result, added } of [retried, thrown]) {
      expect(result.status).toBe("done")
      expectInvariant(added)
      const i = added.findIndex((e) => e.type === "core.error")
      expect(i).toBeGreaterThan(0)
      expect(added[i + 1]?.type).not.toBe("core.run_ended")
    }
  })

  it("续跑 run：第一条是 tools_bound，排在 run_resumed / approval_decision 之前", async () => {
    const log = new InMemoryEventLog()
    const first = await pausedOnApproval(log)
    if (first.result.status !== "paused") return
    const second = await runOnce(log, [{ drafts: [say("上线了")] }], {
      resume: first.result.state,
      decisions: [{ toolCallId: "c1", approved: true, by: "boss" }],
    })
    expectInvariant(second.added)
    expect(second.added.slice(0, 3).map((e) => e.type)).toEqual([
      "core.tools_bound",
      "core.run_resumed",
      "core.approval_decision",
    ])
  })
})

describe("awaiting：以时间线 pending 为准", () => {
  it("审批暂停列出请求时间；起步时已中止（非停止）的 run 仍列出跨 run 遗留的未决审批", async () => {
    const log = new InMemoryEventLog()
    const first = await pausedOnApproval(log)
    const request = first.added.find((e) => e.type === "core.approval_request") as CoreEvent
    const expected: AwaitingCall[] = [
      { kind: "approval", toolCallId: "c1", name: "deploy", requestedAt: request.at },
    ]
    expect(tail(first.added).payload).toMatchObject({ reason: "approval", awaiting: expected })

    const aborted = await runOnce(log, [], { signal: AbortSignal.abort(new Error("disconnect")) })
    expectInvariant(aborted.added, { startedAborted: true })
    expect(tail(aborted.added).payload).toMatchObject({ reason: "host", awaiting: expected })
    expect(tail(aborted.added).payload).not.toHaveProperty("stopped")
  })

  it("工具批中途中止：排在后面、已有请求的未决审批照样列出（中断列表里没有它）", async () => {
    const log = new InMemoryEventLog()
    const controller = new AbortController()
    const approveFirst = defineTool<Record<string, never>>({
      name: "deploy",
      description: "",
      inputSchema: {},
      needsApproval: true,
      execute: () => {
        controller.abort(new Error("disconnect"))
        return "deployed"
      },
    })
    const tools = [approveFirst]
    const first = await runOnce(
      log,
      [{ drafts: [callTool("c1", "deploy", {}), callTool("c2", "deploy", {})] }],
      { tools },
    )
    if (first.result.status !== "paused") throw new Error("expected paused")
    const c2Request = first.added.find(
      (e) => e.type === "core.approval_request" && e.payload.toolCallId === "c2",
    ) as CoreEvent
    const second = await runOnce(log, [], {
      tools,
      resume: first.result.state,
      decisions: [{ toolCallId: "c1", approved: true, by: "boss" }],
      signal: controller.signal,
    })
    expect(second.result).toMatchObject({ status: "paused", interruptions: [{ kind: "host" }] })
    expectInvariant(second.added)
    expect(tail(second.added).payload).toMatchObject({
      awaiting: [{ kind: "approval", toolCallId: "c2", name: "deploy", requestedAt: c2Request.at }],
    })
  })

  it("子代理冒泡列出 childSessionId 与子的原因", async () => {
    const delegate = defineTool<Record<string, never>>({
      name: "ask_expert",
      description: "",
      inputSchema: {},
      replayable: true,
      execute: () =>
        subagentPause({
          childSessionId: "child",
          reason: "approval",
          interruptions: [],
          state: {
            v: 1,
            sessionId: "child",
            lastSeq: 1,
            pendingToolCallIds: [],
            pendingDigest: "d",
            configHash: "h",
          },
        }),
    })
    const { added } = await runOnce(
      new InMemoryEventLog(),
      [{ drafts: [callTool("p1", "ask_expert", {})] }],
      {
        tools: [delegate],
      },
    )
    expectInvariant(added)
    expect(tail(added).payload).toMatchObject({
      reason: "approval",
      awaiting: [
        {
          kind: "subagent",
          toolCallId: "p1",
          name: "ask_expert",
          childSessionId: "child",
          reason: "approval",
        },
      ],
    })
  })

  it("用户停止收尾后为 []，且 stopped；RunStop('host') 同样 stopped", async () => {
    for (const by of ["user", "host"] as const) {
      const log = new InMemoryEventLog()
      await pausedOnApproval(log)
      const { added } = await runOnce(log, [], { signal: AbortSignal.abort(new RunStop(by)) })
      expect(tail(added).payload).toMatchObject({ reason: "host", awaiting: [], stopped: true })
    }
  })

  it("纯函数：只列 pending；已有结论、工具不在表里且无请求、非冒泡的一律跳过不抛", () => {
    const ev = <T extends CoreEventType>(seq: number, type: T, payload: CoreEventPayloads[T]) =>
      createCoreEvent(registry, {
        type,
        payload,
        sessionId: SESSION,
        seq,
        at: 1000 + seq,
        id: `e${seq}`,
        actor: "system",
      })
    const timeline = [
      ev(1, "core.tool_call", { toolCallId: "a", name: "deploy", args: {} }),
      ev(2, "core.tool_call", { toolCallId: "b", name: "deploy", args: {} }),
      ev(3, "core.tool_call", { toolCallId: "c", name: "ghost", args: {} }),
      ev(4, "core.tool_call", { toolCallId: "d", name: "pick", args: {} }),
      ev(5, "core.tool_call", { toolCallId: "e", name: "echo", args: {} }),
      ev(6, "core.approval_request", { toolCallId: "a", policyId: "p", summary: "s" }),
      ev(7, "core.approval_request", { toolCallId: "b", policyId: "p", summary: "s" }),
      ev(8, "core.approval_decision", { toolCallId: "b", approved: true, by: "u" }),
      ev(9, "core.tool_call", { toolCallId: "f", name: "echo", args: {} }),
      ev(10, "core.tool_result", { toolCallId: "f", name: "echo", content: [], isError: false }),
    ]
    const awaiting = awaitingOf({
      timeline,
      pending: pendingToolCalls(timeline),
      tools: [echo, deploy, pick],
      interruptions: [],
    })
    expect(awaiting).toEqual([
      { kind: "approval", toolCallId: "a", name: "deploy", requestedAt: 1006 },
      { kind: "client_tool", toolCallId: "d", name: "pick" },
    ])
  })

  it("纯函数：载荷坏掉的审批事件（注册表不校验 payload）只跳过，不抛", () => {
    const bad = (seq: number, type: string) =>
      ({
        id: `b${seq}`,
        sessionId: SESSION,
        seq,
        at: seq,
        type,
        schemaVersion: 1,
        actor: "system",
        trust: "system",
        payload: null,
      }) as Event
    const call = createCoreEvent(registry, {
      type: "core.tool_call",
      payload: { toolCallId: "a", name: "pick", args: {} },
      sessionId: SESSION,
      seq: 1,
      at: 1,
      id: "c1",
      actor: "model",
    })
    const timeline = [call, bad(2, "core.approval_request"), bad(3, "core.approval_decision")]
    expect(
      awaitingOf({ timeline, pending: pendingToolCalls(timeline), tools: [pick], interruptions: [] }),
    ).toEqual([{ kind: "client_tool", toolCallId: "a", name: "pick" }])
  })

  it("isClientTool：没有 execute 或 side client", () => {
    expect(isClientTool(pick)).toBe(true)
    expect(isClientTool({ name: "x", description: "", inputSchema: {} } as Tool)).toBe(true)
    expect(isClientTool(echo)).toBe(false)
  })
})

describe("runStatusOf / lastRunMarker", () => {
  const raw = (type: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
    id: `m-${type}`,
    sessionId: SESSION,
    seq: 7,
    at: 5000,
    type,
    schemaVersion: 1,
    actor: "system",
    trust: "system",
    payload,
    ...extra,
  })
  const status = (marker: unknown, held = false) =>
    runStatusOf({ held, lastMarker: marker as Event | undefined })

  it("RUN_MARKER_TYPES 是三种标记", () => {
    expect([...RUN_MARKER_TYPES]).toEqual(["core.tools_bound", "core.run_paused", "core.run_ended"])
  })

  it("held 优先，不看标记；没有标记为 idle", () => {
    expect(status(raw("core.run_ended", { status: "done" }), true)).toEqual({ state: "running" })
    expect(status(undefined)).toEqual({ state: "idle" })
  })

  it("tools_bound：带 marksEnd → interrupted（startedAt 取 at），不带 → unknown", () => {
    expect(status(raw("core.tools_bound", { toolNames: [], configHash: "h", marksEnd: true }))).toEqual({
      state: "interrupted",
      seq: 7,
      startedAt: 5000,
    })
    expect(status(raw("core.tools_bound", { toolNames: [], configHash: "h" }))).toEqual({ state: "unknown" })
  })

  it("四种结局", () => {
    expect(status(raw("core.run_ended", { status: "done" }))).toEqual({
      state: "done",
      seq: 7,
      endedAt: 5000,
    })
    expect(status(raw("core.run_ended", { status: "handoff", toSessionId: "s2" }))).toEqual({
      state: "handoff",
      seq: 7,
      endedAt: 5000,
      toSessionId: "s2",
    })
    expect(status(raw("core.run_ended", { status: "error", category: "provider" }))).toEqual({
      state: "error",
      seq: 7,
      endedAt: 5000,
      category: "provider",
    })
    const awaiting = [{ kind: "approval", toolCallId: "c1", name: "deploy", requestedAt: 4000 }]
    expect(status(raw("core.run_paused", { reason: "approval", awaiting, stopped: true }))).toEqual({
      state: "paused",
      seq: 7,
      endedAt: 5000,
      reason: "approval",
      stopped: true,
      awaiting,
    })
    // 老事件：没有 awaiting / stopped
    expect(status(raw("core.run_paused", { reason: "host" }))).toEqual({
      state: "paused",
      seq: 7,
      endedAt: 5000,
      reason: "host",
      stopped: false,
      awaiting: undefined,
    })
  })

  it("读不出或形状不合规一律 unknown，不抛", () => {
    const bad = [
      raw("core.run_ended", { status: "done" }, { schemaVersion: 2 }), // 未来版本
      raw("core.run_ended", { status: "weird" }),
      raw("core.run_ended", { status: "handoff" }),
      raw("core.run_ended", { status: "error" }),
      raw("core.run_ended", null),
      raw("core.run_paused", { reason: "nap" }),
      raw("core.run_paused", { reason: "host", stopped: false }),
      raw("core.run_paused", { reason: "host", awaiting: "x" }),
      raw("core.run_paused", {
        reason: "host",
        awaiting: [{ kind: "approval", toolCallId: "c", name: "n" }],
      }),
      raw("core.run_paused", {
        reason: "host",
        awaiting: [{ kind: "subagent", toolCallId: "c", name: "n" }],
      }),
      raw("core.user_message", { content: [] }), // 不是标记
      raw("ext.unknown", {}),
      { type: "core.run_ended" }, // 壳字段不全
    ]
    for (const m of bad) expect(status(m)).toEqual({ state: "unknown" })
  })

  it("lastRunMarker 取最后一条标记，跳过其后的非标记事件", async () => {
    const log = new InMemoryEventLog()
    await runOnce(log, [{ drafts: [say("好")] }], { input: "hi" })
    const timeline = await all(log)
    expect(lastRunMarker(timeline)?.type).toBe("core.run_ended")
    expect(lastRunMarker([...timeline.slice(0, 2)])?.type).toBe("core.tools_bound")
    expect(lastRunMarker([])).toBeUndefined()
    expect(status(lastRunMarker(timeline))).toMatchObject({ state: "done" })
  })
})
