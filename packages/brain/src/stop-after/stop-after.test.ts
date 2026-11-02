import {
  type CoreEvent,
  type Event,
  InMemoryEventLog,
  type LoopConfig,
  type RunResult,
  runLoop,
  type Socket,
  type Tool,
  type TurnContext,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { budget } from "../budget/index.js"
import { haltOnFailure } from "../halt-on-failure/index.js"
import { handoff } from "../handoff/index.js"
import { stopAfter } from "./stop-after.js"

const SESSION = "s1"
const MODEL = { provider: "scripted", id: "scripted" }

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

const act: Tool = {
  name: "act",
  description: "",
  inputSchema: {},
  execute: (args) =>
    (args as { ok?: boolean }).ok === false
      ? { content: [{ type: "text", text: "failed" }], isError: true }
      : "ok",
}
const endRun: Tool = {
  name: "end_run",
  description: "",
  inputSchema: {},
  execute: (args) =>
    (args as { ok?: boolean }).ok === false
      ? { content: [{ type: "text", text: "bad note" }], isError: true }
      : "ended",
}
const deploy: Tool = {
  name: "deploy",
  description: "",
  inputSchema: {},
  needsApproval: true,
  execute: () => "ok",
}

function config(lowering: ScriptedLowering, log: InMemoryEventLog, sockets: Socket[]): LoopConfig {
  return {
    sessionId: SESSION,
    log,
    lowering,
    model: MODEL,
    tools: [act, endRun, deploy],
    sockets,
    ...deterministic(),
  }
}

describe("stopAfter", () => {
  it("[动作, end_run] 都成功：本轮结束即 done，不再请求模型；先于 budget 的暂停", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("a", "act", {}), callTool("e", "end_run", {})] },
      { drafts: [say("不该被请求")] },
    ])
    const sockets = [stopAfter({ tools: ["end_run"] }), budget({ limits: { toolCalls: 1 } })]
    const result = await drain(runLoop({ ...config(lowering, log, sockets), input: "go" }))
    expect(result.status).toBe("done")
    expect(lowering.requests).toHaveLength(1)
  })

  it("同批有失败、end_run 自身 isError、end_run 被 haltOnFailure 拦下：都不停，模型下一轮看得到", async () => {
    for (const drafts of [
      [callTool("a", "act", { ok: false }), callTool("e", "end_run", {})],
      [callTool("e", "end_run", { ok: false })],
    ]) {
      const log = new InMemoryEventLog()
      const lowering = new ScriptedLowering([{ drafts }, { drafts: [say("handled")] }])
      const sockets = [haltOnFailure(), stopAfter({ tools: ["end_run"] })]
      const result = await drain(runLoop({ ...config(lowering, log, sockets), input: "go" }))
      expect(result.status).toBe("done")
      expect(lowering.requests).toHaveLength(2)
    }
  })

  it("[动作需审批, end_run]：批准续跑、无新输入 → 补跑后直接收尾，不再请求模型", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("d", "deploy", {}), callTool("e", "end_run", {})] },
      { drafts: [say("不该被请求")] },
    ])
    const cfg = config(lowering, log, [stopAfter({ tools: ["end_run"] })])
    expect((await drain(runLoop({ ...cfg, input: "go" }))).status).toBe("paused")
    const second = await drain(
      runLoop({ ...cfg, decisions: [{ sessionId: SESSION, toolCallId: "d", approved: true, by: "boss" }] }),
    )
    expect(second.status).toBe("done")
    expect(lowering.requests).toHaveLength(1)
  })

  it("遗留的 end_run 遇上新用户消息续跑：补跑轮不停，新输入照常交给模型", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("d", "deploy", {}), callTool("e", "end_run", {})] },
      { drafts: [say("新消息处理了")] },
    ])
    const cfg = config(lowering, log, [stopAfter({ tools: ["end_run"] })])
    await drain(runLoop({ ...cfg, input: "go" }))
    const second = await drain(
      runLoop({
        ...cfg,
        input: "还有一件事",
        decisions: [{ sessionId: SESSION, toolCallId: "d", approved: true, by: "boss" }],
      }),
    )
    expect(second.status).toBe("done")
    expect(lowering.requests).toHaveLength(2)
  })

  it("[handoff, end_run] 同批、按推荐顺序 handoff → stopAfter：交接照常兑现", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      {
        drafts: [
          callTool("h", "handoff", { summary: "接着做", nextSteps: ["继续"] }),
          callTool("e", "end_run", {}),
        ],
      },
    ])
    const result = await drain(
      runLoop({
        ...config(lowering, log, [handoff({ rules: false }), stopAfter({ tools: ["end_run"] })]),
        input: "go",
      }),
    )
    expect(result.status).toBe("handoff")
    const types: string[] = []
    for await (const e of log.read(SESSION)) types.push((e as CoreEvent).type)
    expect(types).toContain("core.handoff")
  })

  it("构造期校验；名单工具不在工具表时告警一次", async () => {
    expect(() => stopAfter({ tools: [] })).toThrow(RangeError)
    expect(() => stopAfter({ tools: [""] })).toThrow(RangeError)
    const warnings: string[] = []
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [callTool("a", "act", {})] }, { drafts: [say("done")] }])
    await drain(
      runLoop({
        ...config(lowering, log, [stopAfter({ tools: ["end_rnu"], warn: (m) => warnings.push(m) })]),
        input: "go",
      }),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"end_rnu"')
  })

  it("ctx.batch 缺失（旧循环）：抛出可读错误", () => {
    const socket = stopAfter({ tools: ["end_run"] })
    expect(() => socket.onTurnEnd?.({} as TurnContext)).toThrow(
      /requires a loop that fills TurnContext.batch/,
    )
  })
})
