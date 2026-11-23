/**
 * 暂停原因码（AdRate 建议 16）：Socket 暂停带的 code 随 note 落进 run_paused，实时中断与 runStatusOf 读出同一个码；
 * 意见里不合规的地方被改正并记一条非终结 core.error，照常暂停；code 不进续跑状态。机制正确性，全部假模型。
 */
import { describe, expect, it } from "vitest"
import type { Event } from "../events/base.js"
import type { CoreEvent, CoreEventOf } from "../events/core.js"
import { InMemoryEventLog } from "../store/in-memory.js"
import { callTool, ScriptedLowering, type ScriptedTurn, say } from "../testing/scripted-lowering.js"
import {
  isPauseCode,
  MAX_TURNS_PAUSE_CODE,
  PAUSE_CODE_RE,
  pauseDetailOf,
  resolveSocketPause,
} from "./pause-code.js"
import { runLoop } from "./run-loop.js"
import { lastRunMarker, runStatusOf } from "./run-status.js"
import { RunStop, STOPPED_NOTE } from "./stop.js"
import { defineTool } from "./tools.js"
import type { Interruption, LoopConfig, RunResult, SerializedRunState, TurnDecision } from "./types.js"

const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"
const SECRET = "k"

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

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<RunResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

async function all(log: InMemoryEventLog): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(SESSION)) out.push(e as CoreEvent)
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
      tools: [echo, deploy],
      ...deterministic(),
      ...extra,
    }),
  )
  return { result, added: (await all(log)).slice(before) }
}

/** 一个每轮都要求暂停的 Socket */
const pausing = (pause: Extract<TurnDecision, { pause: unknown }>["pause"]) => ({
  sockets: [{ onTurnEnd: () => ({ pause }) }],
})

const pausedTail = (added: readonly CoreEvent[]) => added.at(-1) as CoreEventOf<"core.run_paused">

describe("Socket 暂停带原因码", () => {
  it("code 与 note 落进 run_paused；实时中断、runStatusOf 读出同一个码", async () => {
    const log = new InMemoryEventLog()
    const { result, added } = await runOnce(log, [{ drafts: [say("x")] }], {
      input: "hi",
      ...pausing({ reason: "budget", code: "acme.credits_exhausted", note: "credits ran out" }),
    })
    expect(result).toMatchObject({
      status: "paused",
      reason: "budget",
      interruptions: [{ kind: "budget", note: "credits ran out", code: "acme.credits_exhausted" }],
    })
    if (result.status !== "paused") return
    expect(pausedTail(added).payload).toEqual({
      reason: "budget",
      state: result.state,
      awaiting: [],
      code: "acme.credits_exhausted",
      note: "credits ran out",
    })
    // 另一个进程只凭日志（经 JSON 往返，与存储里读出来的一样）判状态
    const marker = JSON.parse(JSON.stringify(lastRunMarker(await all(log)))) as Event
    expect(runStatusOf({ held: false, lastMarker: marker })).toEqual({
      state: "paused",
      seq: pausedTail(added).seq,
      endedAt: pausedTail(added).at,
      reason: "budget",
      stopped: false,
      awaiting: [],
      code: "acme.credits_exhausted",
    })
  })

  it("reason 为 host 的 Socket 暂停同样带码", async () => {
    const { result, added } = await runOnce(new InMemoryEventLog(), [{ drafts: [say("x")] }], {
      ...pausing({ reason: "host", code: "acme.account_frozen" }),
    })
    expect(result).toMatchObject({ status: "paused", reason: "host" })
    expect(pausedTail(added).payload).toMatchObject({ reason: "host", code: "acme.account_frozen" })
    expect(pausedTail(added).payload).not.toHaveProperty("stopped")
  })

  it("不带码：载荷没有 code 字段，note 是缺省那句；RunStatus 没有 code", async () => {
    const log = new InMemoryEventLog()
    const { result, added } = await runOnce(log, [{ drafts: [say("x")] }], pausing({ reason: "budget" }))
    if (result.status !== "paused") throw new Error("expected paused")
    expect(result.interruptions).toEqual([{ kind: "budget", note: "a socket requested a pause (budget)" }])
    expect(pausedTail(added).payload).toEqual({
      reason: "budget",
      state: result.state,
      awaiting: [],
      note: "a socket requested a pause (budget)",
    })
    const status = runStatusOf({ held: false, lastMarker: lastRunMarker(await all(log)) })
    expect(status).toMatchObject({ state: "paused", reason: "budget" })
    expect(status).not.toHaveProperty("code")
  })

  it("code 不合规：照常暂停、码丢掉不进时间线，改正处记一条非终结 core.error", async () => {
    const bad: unknown[] = ["Acme.Credits", "", "a".repeat(65), ".leading", "has space", 42, null]
    for (const code of bad) {
      const log = new InMemoryEventLog()
      const { result, added } = await runOnce(log, [{ drafts: [say("x")] }], {
        input: "hi",
        secret: SECRET,
        ...pausing({ reason: "budget", code: code as string, note: "credits ran out" }),
      })
      // 标注写错不改变结局：还是一次带续跑凭据的暂停，只是没有码
      expect(result).toMatchObject({
        status: "paused",
        reason: "budget",
        interruptions: [{ kind: "budget", note: "credits ran out" }],
      })
      if (result.status !== "paused") throw new Error("expected paused")
      expect(result.interruptions[0]).not.toHaveProperty("code")
      expect(result.state.sig).toBeDefined()
      expect(pausedTail(added).payload).toEqual({
        reason: "budget",
        state: result.state,
        awaiting: [],
        note: "credits ran out",
      })
      // 恰好一条终结事件；错误排在它前面，只有 core.error、没有 run_ended
      expect(added.filter((e) => e.type === "core.run_paused" || e.type === "core.run_ended")).toHaveLength(1)
      const error = added.at(-2) as CoreEventOf<"core.error">
      expect(error).toMatchObject({
        type: "core.error",
        payload: { category: "input", retryable: false, detail: { phase: "onTurnEnd" } },
      })
      expect(error.payload.message.startsWith(`pause.code must match ${PAUSE_CODE_RE.source}, got `)).toBe(
        true,
      )
      expect(error.payload.message.endsWith("; the code was dropped.")).toBe(true)
      const status = runStatusOf({ held: false, lastMarker: lastRunMarker(await all(log)) })
      expect(status).toMatchObject({ state: "paused", reason: "budget" })
      expect(status).not.toHaveProperty("code")
    }
  })

  it("reason 不在闭集（JS 宿主想自定义原因）：按 host 暂停并记错，合规的码照留", async () => {
    const log = new InMemoryEventLog()
    const { result, added } = await runOnce(log, [{ drafts: [say("x")] }], {
      input: "hi",
      ...pausing({ reason: "credits" as never, code: "acme.credits_exhausted" }),
    })
    expect(result).toMatchObject({
      status: "paused",
      reason: "host",
      interruptions: [
        { kind: "host", note: "a socket requested a pause (host)", code: "acme.credits_exhausted" },
      ],
    })
    expect(pausedTail(added).payload).toMatchObject({ reason: "host", code: "acme.credits_exhausted" })
    expect((added.at(-2) as CoreEventOf<"core.error">).payload).toEqual({
      category: "input",
      message: 'pause.reason must be "budget" or "host", got "credits"; paused with reason "host" instead.',
      retryable: false,
      detail: { phase: "onTurnEnd" },
    })
    // 照原样写进去的话这里只能判 unknown
    expect(runStatusOf({ held: false, lastMarker: lastRunMarker(await all(log)) })).toMatchObject({
      state: "paused",
      reason: "host",
      code: "acme.credits_exhausted",
    })
  })

  it("合规的意见不记错误：run_paused 前一条不是 core.error", async () => {
    const { added } = await runOnce(new InMemoryEventLog(), [{ drafts: [say("x")] }], {
      input: "hi",
      ...pausing({ reason: "budget", code: "acme.credits_exhausted" }),
    })
    expect(added.some((e) => e.type === "core.error")).toBe(false)
  })

  it("resolveSocketPause：永不抛错；报错复述宿主给的值（字符串加引号、超长截断，非字符串只说类型）", () => {
    expect(resolveSocketPause({ reason: "budget" })).toEqual({
      interruption: { kind: "budget", note: "a socket requested a pause (budget)" },
    })
    expect(resolveSocketPause({ reason: "host", code: "a.b", note: "n" })).toEqual({
      interruption: { kind: "host", note: "n", code: "a.b" },
    })
    const messageOf = (pause: Parameters<typeof resolveSocketPause>[0]) =>
      resolveSocketPause(pause).error?.message
    const head = `pause.code must match ${PAUSE_CODE_RE.source}, got `
    expect(messageOf({ reason: "budget", code: "Bad" })).toBe(`${head}"Bad"; the code was dropped.`)
    expect(messageOf({ reason: "budget", code: 42 })).toBe(`${head}number; the code was dropped.`)
    expect(messageOf({ reason: "budget", code: null })).toBe(`${head}null; the code was dropped.`)
    expect(messageOf({ reason: "budget", code: "x".repeat(500) })).toBe(
      `${head}"${"x".repeat(80)}…"; the code was dropped.`,
    )
    // 两处都不合规：一条错误里两句，reason 在前
    const both = resolveSocketPause({ reason: undefined, code: "Bad" })
    expect(both.interruption).toEqual({ kind: "host", note: "a socket requested a pause (host)" })
    expect(both.error?.message).toBe(
      `pause.reason must be "budget" or "host", got undefined; paused with reason "host" instead. ${head}"Bad"; the code was dropped.`,
    )
  })
})

describe("循环自己的暂停", () => {
  it("maxTurns 兜底：code 为 reins.max_turns", async () => {
    const log = new InMemoryEventLog()
    const { result, added } = await runOnce(log, [{ drafts: [callTool("c1", "echo", {})] }], {
      input: "hi",
      maxTurns: 1,
    })
    expect(MAX_TURNS_PAUSE_CODE).toBe("reins.max_turns")
    expect(result).toMatchObject({
      status: "paused",
      reason: "budget",
      interruptions: [
        { kind: "budget", note: "reached the per-run turn limit of 1", code: "reins.max_turns" },
      ],
    })
    expect(pausedTail(added).payload).toMatchObject({
      reason: "budget",
      code: "reins.max_turns",
      note: "reached the per-run turn limit of 1",
    })
    expect(runStatusOf({ held: false, lastMarker: lastRunMarker(await all(log)) })).toMatchObject({
      state: "paused",
      code: "reins.max_turns",
    })
  })

  it("审批暂停：载荷没有 code / note（等的是谁已在 awaiting 里）", async () => {
    const { result, added } = await runOnce(new InMemoryEventLog(), [
      { drafts: [callTool("c1", "deploy", {})] },
    ])
    expect(result).toMatchObject({ status: "paused", reason: "approval" })
    expect(pausedTail(added).payload).not.toHaveProperty("code")
    expect(pausedTail(added).payload).not.toHaveProperty("note")
  })

  it("宿主中止（非停止）：不带码，note 是中止那句", async () => {
    const { added } = await runOnce(new InMemoryEventLog(), [], { signal: AbortSignal.abort() })
    expect(pausedTail(added).payload).toMatchObject({
      reason: "host",
      note: "host aborted before this turn started",
    })
    expect(pausedTail(added).payload).not.toHaveProperty("code")
    expect(pausedTail(added).payload).not.toHaveProperty("stopped")
  })

  it("用户停止盖过 Socket 的暂停意见：stopped、没有 code、note 是停止那句", async () => {
    const controller = new AbortController()
    const { result, added } = await runOnce(new InMemoryEventLog(), [{ drafts: [say("x")] }], {
      input: "hi",
      signal: controller.signal,
      sockets: [
        {
          onTurnEnd: () => {
            // 用户恰好在 Socket 给意见的同时点了停止
            controller.abort(new RunStop())
            return { pause: { reason: "budget" as const, code: "acme.credits_exhausted" } }
          },
        },
      ],
    })
    expect(result).toMatchObject({
      status: "paused",
      reason: "host",
      interruptions: [{ kind: "host", note: STOPPED_NOTE }],
    })
    expect(pausedTail(added).payload).toMatchObject({ reason: "host", stopped: true, note: STOPPED_NOTE })
    expect(pausedTail(added).payload).not.toHaveProperty("code")
  })
})

describe("不合规的码不改变别的结局", () => {
  it("用户停止 + 不合规码：仍是停止暂停（stopped），不是 error", async () => {
    const controller = new AbortController()
    const { result, added } = await runOnce(new InMemoryEventLog(), [{ drafts: [say("x")] }], {
      input: "hi",
      signal: controller.signal,
      sockets: [
        {
          onTurnEnd: () => {
            controller.abort(new RunStop())
            return { pause: { reason: "budget" as const, code: "Not A Code" } }
          },
        },
      ],
    })
    expect(result).toMatchObject({ status: "paused", reason: "host" })
    expect(pausedTail(added).payload).toMatchObject({ reason: "host", stopped: true, note: STOPPED_NOTE })
    expect(pausedTail(added).payload).not.toHaveProperty("code")
  })

  it("宿主中止（非停止）落在工具批中途 + 不合规码：暂停而不是 error，没执行的调用留着下次补跑", async () => {
    const controller = new AbortController()
    const aborter = defineTool<Record<string, never>>({
      name: "aborter",
      risk: "low",
      description: "",
      inputSchema: {},
      execute: () => {
        controller.abort(new Error("lost lease"))
        return "ok"
      },
    })
    const log = new InMemoryEventLog()
    const { result, added } = await runOnce(
      log,
      [{ drafts: [callTool("c1", "aborter", {}), callTool("c2", "echo", {})] }],
      {
        input: "hi",
        tools: [aborter, echo],
        signal: controller.signal,
        ...pausing({ reason: "budget", code: "Not A Code" }),
      },
    )
    expect(result.status).toBe("paused")
    if (result.status !== "paused") return
    // c2 没执行、仍 pending：结局必须是带状态的暂停，下一个 run 才补得上
    expect(result.state.pendingToolCallIds).toEqual(["c2"])
    expect(added.some((e) => e.type === "core.run_ended")).toBe(false)
    expect(pausedTail(added).type).toBe("core.run_paused")
  })
})

describe("code 只是标注：不进续跑状态", () => {
  /** 同一段脚本、同一把密钥，只差 Socket 给不给码 */
  async function pausedState(
    code: string | undefined,
  ): Promise<{ log: InMemoryEventLog; state: SerializedRunState }> {
    const log = new InMemoryEventLog()
    const { result } = await runOnce(log, [{ drafts: [say("x")] }], {
      input: "hi",
      secret: SECRET,
      ...pausing({ reason: "budget", ...(code !== undefined ? { code } : {}), note: "n" }),
    })
    if (result.status !== "paused") throw new Error("expected paused")
    return { log, state: result.state }
  }

  it("带码与不带码签出来的状态逐字相同", async () => {
    const withCode = await pausedState("acme.credits_exhausted")
    const without = await pausedState(undefined)
    expect(withCode.state.sig).toBeDefined()
    expect(withCode.state).toEqual(without.state)
  })

  it("带码暂停后凭日志里的状态续跑通过", async () => {
    const { log, state } = await pausedState("acme.credits_exhausted")
    const { result } = await runOnce(log, [{ drafts: [say("接着做")] }], {
      secret: SECRET,
      resume: JSON.parse(JSON.stringify(state)) as SerializedRunState,
      input: "充好了，继续",
      // 续跑的 run 不再装那个暂停的 Socket（它不贡献工具与提示，不影响配置摘要）
    })
    expect(result.status).toBe("done")
  })
})

describe("isPauseCode / pauseDetailOf / runStatusOf 守卫", () => {
  it("isPauseCode 边界表", () => {
    const ok = ["a", "0", "reins.budget", "acme.credits_exhausted", "ns:sub-item_1.x", "a".repeat(64)]
    const bad = [
      "",
      "A",
      "acme.Credits",
      ".a",
      "-a",
      "_a",
      ":a",
      "a b",
      "a/b",
      "a\n",
      "积分",
      "a".repeat(65),
      42,
      null,
      undefined,
      {},
    ]
    for (const x of ok) expect(isPauseCode(x), String(x)).toBe(true)
    for (const x of bad) expect(isPauseCode(x), String(x)).toBe(false)
  })

  it("pauseDetailOf：只取 budget / host 那条；其余三种中断不贡献", () => {
    const call = { toolCallId: "c1", name: "deploy", args: {} }
    const approval: Interruption = {
      kind: "approval",
      toolCallId: "c1",
      call,
      request: { toolCallId: "c1", policyId: "p", summary: "s" } as never,
    }
    const clientTool: Interruption = { kind: "client_tool", toolCallId: "c1", call }
    const subagent: Interruption = {
      kind: "subagent",
      toolCallId: "c1",
      call,
      childSessionId: "s1:c1",
      reason: "budget",
      // 子自己的码留在子的中断里，不上浮
      interruptions: [{ kind: "budget", note: "child", code: "acme.child" }],
      state: {} as never,
    }
    expect(pauseDetailOf([])).toEqual({})
    expect(pauseDetailOf([approval, clientTool, subagent])).toEqual({})
    expect(pauseDetailOf([{ kind: "host", note: "n" }])).toEqual({ note: "n" })
    expect(pauseDetailOf([approval, { kind: "budget", note: "n", code: "reins.budget" }])).toEqual({
      code: "reins.budget",
      note: "n",
    })
  })

  it("runStatusOf：老事件没有 code 字段；code 在场且不合规 → unknown", () => {
    const raw = (payload: unknown) =>
      ({
        id: "m",
        sessionId: SESSION,
        seq: 7,
        at: 5000,
        type: "core.run_paused",
        schemaVersion: 1,
        actor: "system",
        trust: "system",
        payload,
      }) as Event
    const old = runStatusOf({ held: false, lastMarker: raw({ reason: "budget" }) })
    expect(old).toEqual({
      state: "paused",
      seq: 7,
      endedAt: 5000,
      reason: "budget",
      stopped: false,
      awaiting: undefined,
    })
    expect(old).not.toHaveProperty("code")
    // note 不进 RunStatus，也不参与守卫
    expect(
      runStatusOf({ held: false, lastMarker: raw({ reason: "budget", code: "a.b", note: 42 }) }),
    ).toEqual({
      state: "paused",
      seq: 7,
      endedAt: 5000,
      reason: "budget",
      stopped: false,
      awaiting: undefined,
      code: "a.b",
    })
    for (const code of ["Bad", "", 42, null, "a".repeat(65)]) {
      expect(runStatusOf({ held: false, lastMarker: raw({ reason: "budget", code }) })).toEqual({
        state: "unknown",
      })
    }
  })
})
