import {
  type CoreEvent,
  createCoreEvent,
  createCoreRegistry,
  type Event,
  InMemoryEventLog,
  type LoopConfig,
  type RunResult,
  runLoop,
  type Socket,
  type Tool,
  type ToolResultEvent,
  type TurnContext,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { approval } from "../approval/index.js"
import { haltedText, haltOnFailure } from "./halt-on-failure.js"

const SESSION = "s1"
const MODEL = { provider: "scripted", id: "scripted" }
const registry = createCoreRegistry()

function deterministic() {
  let t = 1_800_000_000_000
  let n = 0
  return { now: () => ++t, newId: () => `id${++n}` }
}

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<RunResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

async function results(log: InMemoryEventLog): Promise<Map<string, ToolResultEvent>> {
  const out = new Map<string, ToolResultEvent>()
  for await (const raw of log.read(SESSION)) {
    const e = raw as CoreEvent
    if (e.type === "core.tool_result") out.set(e.payload.toolCallId, e as ToolResultEvent)
  }
  return out
}
const textOf = (r: ToolResultEvent | undefined) =>
  r?.payload.content.map((p) => (p.type === "text" ? p.text : "")).join("")

/** 记执行顺序；ok: false 返回 isError，throw: true 抛错 */
function tools(executed: string[]): Tool[] {
  const mk = (name: string, risk?: "low"): Tool => ({
    name,
    description: "",
    inputSchema: {},
    ...(risk ? { risk } : {}),
    execute: (args) => {
      executed.push(name)
      const a = args as { ok?: boolean; throw?: boolean }
      if (a.throw) throw new Error("boom")
      return a.ok === false ? { content: [{ type: "text", text: "rev stale" }], isError: true } : "ok"
    },
  })
  return [
    mk("board_update"),
    mk("chat_send"),
    mk("lookup", "low"),
    {
      name: "deploy",
      description: "",
      inputSchema: {},
      needsApproval: true,
      execute: () => {
        executed.push("deploy")
        return "ok"
      },
    },
  ]
}

function config(
  lowering: ScriptedLowering,
  log: InMemoryEventLog,
  executed: string[],
  sockets: Socket[],
): LoopConfig {
  return {
    sessionId: SESSION,
    log,
    lowering,
    model: MODEL,
    tools: tools(executed),
    sockets,
    ...deterministic(),
  }
}

describe("haltOnFailure", () => {
  it("[F, A, B]：A、B 各落一条 isError、不执行、不计 toolCalls；B 点名最初失败的 F", async () => {
    const log = new InMemoryEventLog()
    const executed: string[] = []
    const lowering = new ScriptedLowering([
      {
        drafts: [
          callTool("f", "board_update", { ok: false }),
          callTool("a", "chat_send", {}),
          callTool("b", "chat_send", {}),
        ],
      },
      { drafts: [say("fixing")] },
    ])
    let toolCalls = -1
    const spy: Socket = {
      onTurnEnd: (ctx) => {
        toolCalls = ctx.budget.toolCalls
        return undefined
      },
    }
    await drain(runLoop({ ...config(lowering, log, executed, [haltOnFailure(), spy]), input: "go" }))
    expect(executed).toEqual(["board_update"])
    expect(toolCalls).toBe(1)
    const r = await results(log)
    expect(r.get("a")?.payload.isError).toBe(true)
    expect(textOf(r.get("a"))).toBe(`Tool call blocked: ${haltedText("board_update", "f", "failed")}`)
    expect(textOf(r.get("b"))).toBe(`Tool call blocked: ${haltedText("board_update", "f", "failed")}`)
  })

  it("执行抛错同样算失败；前面成功或没有前序时不拦", async () => {
    const log = new InMemoryEventLog()
    const executed: string[] = []
    const lowering = new ScriptedLowering([
      { drafts: [callTool("ok", "board_update", {}), callTool("a", "chat_send", {})] },
      { drafts: [callTool("t", "board_update", { throw: true }), callTool("b", "chat_send", {})] },
      { drafts: [say("done")] },
    ])
    await drain(runLoop({ ...config(lowering, log, executed, [haltOnFailure()]), input: "go" }))
    expect(executed).toEqual(["board_update", "chat_send", "board_update"])
    expect((await results(log)).get("b")?.payload.isError).toBe(true)
  })

  it("counts 排除的失败不触发；applies 为假的后续调用照跑", async () => {
    const log = new InMemoryEventLog()
    const executed: string[] = []
    const lowering = new ScriptedLowering([
      {
        drafts: [
          callTool("q", "lookup", { ok: false }),
          callTool("f", "board_update", { ok: false }),
          callTool("l", "lookup", {}),
          callTool("a", "chat_send", {}),
        ],
      },
      { drafts: [say("done")] },
    ])
    const socket = haltOnFailure({
      counts: (r) => r.payload.name !== "lookup",
      applies: (_call, tool) => tool?.risk !== "low",
    })
    await drain(runLoop({ ...config(lowering, log, executed, [socket]), input: "go" }))
    // q 失败不算数 → f 照跑；f 失败 → l 是只读照跑，a 被拦
    expect(executed).toEqual(["lookup", "board_update", "lookup"])
    expect(textOf((await results(log)).get("a"))).toContain("(board_update, f) failed")
  })

  it("[X 需审批, A]：A 以 still waiting 被拦；批准续跑后 X 执行，A 不再执行", async () => {
    const log = new InMemoryEventLog()
    const executed: string[] = []
    const lowering = new ScriptedLowering([
      { drafts: [callTool("x", "deploy", {}), callTool("a", "chat_send", {})] },
      { drafts: [say("deployed, will announce")] },
    ])
    const cfg = config(lowering, log, executed, [haltOnFailure()])
    const first = await drain(runLoop({ ...cfg, input: "go" }))
    expect(first.status).toBe("paused")
    expect(textOf((await results(log)).get("a"))).toContain("(deploy, x) is still waiting")
    const second = await drain(
      runLoop({ ...cfg, decisions: [{ sessionId: SESSION, toolCallId: "x", approved: true, by: "boss" }] }),
    )
    expect(second.status).toBe("done")
    expect(executed).toEqual(["deploy"])
  })

  it("F 执行失败后宿主中止：续跑补跑轮靠预置结果仍拦下 A", async () => {
    const log = new InMemoryEventLog()
    const executed: string[] = []
    const ac = new AbortController()
    const failing: Tool = {
      name: "board_update",
      description: "",
      inputSchema: {},
      execute: () => {
        executed.push("board_update")
        ac.abort()
        return { content: [{ type: "text", text: "rev stale" }], isError: true }
      },
    }
    const lowering = new ScriptedLowering([
      { drafts: [callTool("f", "board_update", {}), callTool("a", "chat_send", {})] },
      { drafts: [say("fixing")] },
    ])
    const base = config(lowering, log, executed, [haltOnFailure()])
    const cfg = { ...base, tools: [failing, ...(base.tools ?? []).filter((t) => t.name !== "board_update")] }
    const first = await drain(runLoop({ ...cfg, input: "go", signal: ac.signal }))
    expect(first.status).toBe("paused")
    await drain(runLoop(cfg))
    expect(executed).toEqual(["board_update"])
    expect(textOf((await results(log)).get("a"))).toContain("(board_update, f) failed")
  })

  it("排在 rewrite 的 Socket 之后按 toolCallId 定位；排在 approval 之前时被拦的调用不再问人", async () => {
    const log = new InMemoryEventLog()
    const executed: string[] = []
    const lowering = new ScriptedLowering([
      { drafts: [callTool("f", "board_update", { ok: false }), callTool("a", "chat_send", {})] },
      { drafts: [say("done")] },
    ])
    const rewriter: Socket = { beforeTool: (_c, call) => ({ rewrite: { ...(call.payload.args as object) } }) }
    const result = await drain(
      runLoop({
        ...config(lowering, log, executed, [
          rewriter,
          haltOnFailure(),
          approval({ ask: ["chat_send"], allow: ["*"], rules: false }),
        ]),
        input: "go",
      }),
    )
    // chat_send 被 haltOnFailure 拦下，approval 看不到它，run 不会因审批暂停
    expect(result.status).toBe("done")
    expect(textOf((await results(log)).get("a"))).toContain("(board_update, f) failed")
  })

  it("ctx.batch 缺失（旧循环）：抛出可读错误", () => {
    const socket = haltOnFailure()
    const ctx = {} as TurnContext
    const call = createCoreEvent(registry, {
      ...callTool("a", "chat_send", {}),
      sessionId: SESSION,
      seq: 1,
    } as never)
    expect(() => socket.beforeTool?.(ctx, call as never, undefined)).toThrow(
      /requires a loop that fills TurnContext.batch/,
    )
  })
})
