import { describe, expect, it } from "vitest"
import type { Event } from "../events/base.js"
import type { CoreEvent, CoreEventOf } from "../events/core.js"
import { createCoreEvent } from "../events/create.js"
import { createCoreRegistry } from "../events/registry.js"
import { InMemoryEventLog } from "../store/in-memory.js"
import { callTool, ScriptedLowering, say } from "../testing/scripted-lowering.js"
import { runLoop } from "./run-loop.js"
import { type RunStateError, signRunState, verifyRunState } from "./state.js"
import type { LoopConfig, RunResult, SerializedRunState, Tool } from "./types.js"

const registry = createCoreRegistry()
const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"
const SECRET = "boss-only-knows"

const deployTool: Tool = {
  name: "deploy",
  description: "上线",
  inputSchema: { type: "object" },
  needsApproval: true,
  execute: (input) => `已上线 ${JSON.stringify(input)}`,
}

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<{ events: Event[]; result: RunResult }> {
  const events: Event[] = []
  while (true) {
    const step = await gen.next()
    if (step.done) return { events, result: step.value }
    events.push(step.value)
  }
}

async function all(log: InMemoryEventLog): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(SESSION)) out.push(e as CoreEvent)
  return out
}
const types = (events: readonly Event[]) => events.map((e) => e.type.replace("core.", ""))

/**
 * 进程 A：模型要上线，工具要审批 → 暂停。返回它交出去的状态（已是普通字符串，可放 URL）与共享的日志。
 * 进程 B 只拿到这两样东西。
 */
async function processA(opts: { secret?: string } = { secret: SECRET }) {
  const secret = opts.secret
  const log = new InMemoryEventLog()
  const lowering = new ScriptedLowering([{ drafts: [callTool("c1", "deploy", { env: "prod" })] }])
  const cfg: LoopConfig = {
    sessionId: SESSION,
    log,
    lowering,
    model: MODEL,
    tools: [deployTool],
    systemPrompt: "你是运维",
    ...(secret !== undefined ? { secret } : {}),
  }
  const { result } = await drain(runLoop({ ...cfg, input: "上线到生产" }))
  if (result.status !== "paused") throw new Error(`期望 paused，得到 ${result.status}`)
  return { log, stateString: JSON.stringify(result.state), result, cfg }
}

/** 进程 B：全新的降级层实例与配置对象，只共享日志 */
function processB(log: InMemoryEventLog, overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    sessionId: SESSION,
    log,
    lowering: new ScriptedLowering([{ drafts: [say("上线完成")] }]),
    model: MODEL,
    tools: [deployTool],
    systemPrompt: "你是运维",
    secret: SECRET,
    ...overrides,
  }
}

describe("RunState：进程 A 暂停、进程 B 恢复", () => {
  it("状态小、可放 URL、已签名", async () => {
    const { stateString, result } = await processA()
    expect(stateString.length).toBeLessThan(400)
    const state = JSON.parse(stateString) as SerializedRunState
    expect(state).toMatchObject({ v: 1, sessionId: SESSION, lastSeq: 6, pendingToolCallIds: ["c1"] })
    expect(state.sig).toMatch(/^[0-9a-f]{64}$/)
    expect(state.pendingDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(await verifyRunState(state, SECRET)).toBe(true)
    expect(await verifyRunState(state, "别的密钥")).toBe(false)
    expect(result.status === "paused" && result.reason).toBe("approval")
  })

  it("进程 B 带批准恢复：记 run_resumed 与 approval_decision，执行工具，跑到 done", async () => {
    const { log, stateString } = await processA()
    const before = (await all(log)).length

    const cfgB = processB(log, {
      resume: JSON.parse(stateString),
      decisions: [{ toolCallId: "c1", approved: true, by: "boss" }],
    })
    const { events, result } = await drain(runLoop(cfgB))
    expect(result).toEqual({ status: "done", sessionId: SESSION, lastSeq: 12 })

    const logged = await all(log)
    expect(types(logged.slice(before))).toEqual([
      "run_resumed",
      "approval_decision",
      // 续跑起步的工具表快照：在 run_resumed / approval_decision 之后、补齐 pending 之前
      "tools_bound",
      "tool_result",
      "model_text",
      "budget_usage",
    ])
    const resumed = logged[before] as CoreEventOf<"core.run_resumed">
    expect(resumed.payload).toEqual({ by: "boss" })
    expect(resumed.actor).toBe("host")
    const decision = logged[before + 1] as CoreEventOf<"core.approval_decision">
    expect(decision.payload).toEqual({ toolCallId: "c1", approved: true, by: "boss" })
    const res = logged[before + 3] as CoreEventOf<"core.tool_result">
    expect(res.payload).toMatchObject({
      isError: false,
      content: [{ type: "text", text: '已上线 {"env":"prod"}' }],
    })
    // 进程 B 也把新事件逐条 yield 出来了
    expect(events.map((e) => e.seq)).toEqual([7, 8, 9, 10, 11, 12])
    // 模型看到的是干净的对话：审批与暂停/恢复事件不可见
    const b = cfgB.lowering as ScriptedLowering
    expect(types(b.requests[0]?.events ?? [])).toEqual(["user_message", "tool_call", "tool_result"])
  })

  it("进程 B 拒绝：工具不执行，模型看到 isError 的结果", async () => {
    const { log, stateString } = await processA()
    const { result } = await drain(
      runLoop(
        processB(log, {
          resume: JSON.parse(stateString),
          decisions: [{ toolCallId: "c1", approved: false, by: "boss", reason: "先别" }],
        }),
      ),
    )
    expect(result.status).toBe("done")
    const res = (await all(log)).find((e) => e.type === "core.tool_result") as CoreEventOf<"core.tool_result">
    expect(res.payload.isError).toBe(true)
    expect(res.payload.content).toEqual([{ type: "text", text: "Approval denied: 先别" }])
  })

  it("恢复但没给结论：不重复发 approval_request，再次暂停并交出新状态", async () => {
    const { log, stateString } = await processA()
    const { result } = await drain(runLoop(processB(log, { resume: JSON.parse(stateString) })))
    expect(result.status).toBe("paused")
    if (result.status !== "paused") return
    expect(types(await all(log)).filter((t) => t === "approval_request")).toHaveLength(1)
    expect(result.state.lastSeq).toBeGreaterThan((JSON.parse(stateString) as SerializedRunState).lastSeq)
    expect(await verifyRunState(result.state, SECRET)).toBe(true)
  })

  it("不传 resume 只传 decisions 也行：宿主自己保证会话对得上", async () => {
    const { log } = await processA()
    const { result } = await drain(
      runLoop(processB(log, { decisions: [{ toolCallId: "c1", approved: true, by: "boss" }] })),
    )
    expect(result.status).toBe("done")
    expect(types(await all(log))).not.toContain("run_resumed")
  })
})

describe("RunState：恢复校验 fail-closed，拒绝发生在写日志之前", () => {
  async function expectReject(cfg: LoopConfig, code: RunStateError["code"]) {
    const before = (await all(cfg.log as InMemoryEventLog)).length
    await expect(drain(runLoop(cfg))).rejects.toMatchObject({ name: "RunStateError", code })
    expect((await all(cfg.log as InMemoryEventLog)).length).toBe(before)
  }

  it("改了 pending 列表 → bad_signature", async () => {
    const { log, stateString } = await processA()
    const state = JSON.parse(stateString) as SerializedRunState
    state.pendingToolCallIds = ["c2"]
    await expectReject(processB(log, { resume: state }), "bad_signature")
  })

  it("改了 lastSeq → bad_signature", async () => {
    const { log, stateString } = await processA()
    const state = JSON.parse(stateString) as SerializedRunState
    state.lastSeq = 3
    await expectReject(processB(log, { resume: state }), "bad_signature")
  })

  it("进程 B 密钥不同 → bad_signature", async () => {
    const { log, stateString } = await processA()
    await expectReject(processB(log, { resume: JSON.parse(stateString), secret: "另一把" }), "bad_signature")
  })

  it("去掉签名 → missing_signature；用正确密钥重新签回去又能过", async () => {
    const { log, stateString } = await processA()
    const { sig: _drop, ...unsigned } = JSON.parse(stateString) as SerializedRunState
    await expectReject(processB(log, { resume: unsigned as SerializedRunState }), "missing_signature")
    const resigned = await signRunState(unsigned as SerializedRunState, SECRET)
    const { result } = await drain(
      runLoop(
        processB(log, { resume: resigned, decisions: [{ toolCallId: "c1", approved: true, by: "boss" }] }),
      ),
    )
    expect(result.status).toBe("done")
  })

  it("状态属于别的会话 → session_mismatch", async () => {
    const { log, stateString } = await processA()
    const state = JSON.parse(stateString) as SerializedRunState
    await expectReject(processB(log, { resume: { ...state, sessionId: "s2" } }), "session_mismatch")
  })

  it("工具集变了 → config_mismatch；allowConfigDrift 放行", async () => {
    const { log, stateString } = await processA()
    const extra: Tool = { name: "rollback", description: "", inputSchema: {}, execute: () => "" }
    await expectReject(
      processB(log, { resume: JSON.parse(stateString), tools: [deployTool, extra] }),
      "config_mismatch",
    )
    const { result } = await drain(
      runLoop(
        processB(log, {
          resume: JSON.parse(stateString),
          tools: [deployTool, extra],
          allowConfigDrift: true,
          decisions: [{ toolCallId: "c1", approved: true, by: "boss" }],
        }),
      ),
    )
    expect(result.status).toBe("done")
  })

  it("系统提示变了也算配置变了 → config_mismatch", async () => {
    const { log, stateString } = await processA()
    await expectReject(
      processB(log, { resume: JSON.parse(stateString), systemPrompt: "你是财务" }),
      "config_mismatch",
    )
  })

  it("连到一份空日志 → log_behind", async () => {
    const { stateString } = await processA()
    await expectReject(processB(new InMemoryEventLog(), { resume: JSON.parse(stateString) }), "log_behind")
  })

  it("日志里的 pending 调用已被别人回填 → pending_mismatch", async () => {
    const { log, stateString } = await processA()
    const tailSeq = (await log.tail(SESSION, 1))[0]?.seq ?? 0
    await log.append([
      createCoreEvent(registry, {
        type: "core.tool_result",
        actor: "tool",
        sessionId: SESSION,
        seq: tailSeq + 1,
        payload: {
          toolCallId: "c1",
          name: "deploy",
          content: [{ type: "text", text: "手动" }],
          isError: false,
        },
      }),
    ])
    await expectReject(processB(log, { resume: JSON.parse(stateString) }), "pending_mismatch")
  })

  it("decisions 指向不在等待中的调用 → unknown_tool_call", async () => {
    const { log, stateString } = await processA()
    await expectReject(
      processB(log, {
        resume: JSON.parse(stateString),
        decisions: [{ toolCallId: "c9", approved: true, by: "boss" }],
      }),
      "unknown_tool_call",
    )
  })

  it("形状不对 → malformed", async () => {
    const { log } = await processA()
    await expectReject(processB(log, { resume: { v: 2 } as unknown as SerializedRunState }), "malformed")
  })

  it("没配密钥：状态不签名、恢复不验签（只适合可信环境）", async () => {
    const { log, stateString } = await processA({})
    const state = JSON.parse(stateString) as SerializedRunState
    expect(state.sig).toBeUndefined()
    const cfg = processB(log, {
      resume: state,
      decisions: [{ toolCallId: "c1", approved: true, by: "boss" }],
    })
    delete cfg.secret
    const { result } = await drain(runLoop(cfg))
    expect(result.status).toBe("done")
  })
})
