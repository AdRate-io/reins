/**
 * 脑子模块按 README 推荐顺序整套同装的集成用例（全库审查 2026-11-25 #70）。
 *
 * 各模块的单测各管各的；这里锁住"装在一起时的顺序约定"与跨 run 的停止 / 续跑场景，
 * 改动 ctx.timeline 语义、Socket 顺序或 approval 管线时由它拦下回归：
 * haltOnFailure → handoff → stopAfter → compact → budget → pins → lazyTools → approval。
 */
import {
  type CoreEvent,
  type Event,
  InMemoryEventLog,
  type LoopConfig,
  type RunResult,
  RunStop,
  runLoop,
  type Tool,
  type ToolResultEvent,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { approval } from "./approval/index.js"
import { budget } from "./budget/index.js"
import { compact } from "./compact/index.js"
import { haltOnFailure } from "./halt-on-failure/index.js"
import { handoff } from "./handoff/index.js"
import { lazyTools, TOOL_FIND_TOOL_NAME } from "./lazy-tools/index.js"
import { pins } from "./pins/index.js"
import { stopAfter } from "./stop-after/index.js"

const SESSION = "s1"
const MODEL = { provider: "scripted", id: "scripted" }

function deterministic() {
  let t = 1_800_000_000_000
  let n = 0
  return { now: () => ++t, newId: () => `id${++n}` }
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

const resultOf = (events: readonly CoreEvent[], toolCallId: string) =>
  events.find(
    (e): e is ToolResultEvent => e.type === "core.tool_result" && e.payload.toolCallId === toolCallId,
  ) as ToolResultEvent
const textOf = (r: ToolResultEvent) =>
  r.payload.content.map((p) => (p.type === "text" ? p.text : "")).join("")

const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
  name,
  description: `Tool ${name}.`,
  inputSchema: { type: "object" },
  execute: () => `${name} ran`,
  ...extra,
})

/** README 推荐的完整顺序；每次 run 新建实例（模拟换进程续跑，内存里没有上一个 run 的状态） */
const stack = () => [
  haltOnFailure({ applies: (_call, t) => t?.risk !== "low" }),
  handoff(),
  stopAfter({ tools: ["end_run"] }),
  compact(),
  budget({ limits: { turns: 30 } }),
  pins(),
  lazyTools({ warn: () => {} }),
  approval({
    ask: [
      {
        id: "deploy-gate",
        match: (c) => c.name === "deploy",
        summary: (c) => `deploy to ${(c.args as { env: { name: string } }).env.name}`,
      },
    ],
  }),
]

const tools = () => [
  tool("greet", { risk: "low" }),
  tool("end_run", { risk: "low" }),
  tool("deploy", { risk: "high" }),
  tool("ads_disable", { lazy: true, risk: "high" }),
]

function config(
  lowering: ScriptedLowering,
  log: InMemoryEventLog,
  extra: Partial<LoopConfig> = {},
): LoopConfig {
  return {
    sessionId: SESSION,
    log,
    lowering,
    model: MODEL,
    tools: tools(),
    sockets: stack(),
    ...deterministic(),
    ...extra,
  }
}

describe("脑子模块整套同装（README 推荐顺序）", () => {
  it("未取回的菜单工具被 lazyTools 拦下指向 tool_find，摘要函数抛错按 deny 收口，run 照常结束", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c0", "ads_disable", {})] },
      { drafts: [callTool("c1", "deploy", { env: null })] },
      { drafts: [say("好")] },
    ])
    const { result } = await drain(runLoop(config(lowering, log, { input: "开始" })))
    expect(result.status).toBe("done")
    const events = await all(log)
    expect(textOf(resultOf(events, "c0"))).toContain(TOOL_FIND_TOOL_NAME)
    const denied = resultOf(events, "c1")
    expect(denied.payload.isError).toBe(true)
    expect(textOf(denied)).toContain("deploy-gate")
    expect(events.some((e) => e.type === "core.approval_request")).toBe(false)
  })

  it("交接与要审批的调用同批 → 暂停 → 用户停止 → 新消息只得到文字回复：不兑现旧交接", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      {
        drafts: [
          callTool("h1", "handoff", { summary: "Hand over.", nextSteps: ["a"] }),
          callTool("d1", "deploy", { env: { name: "prod" } }),
        ],
      },
      { drafts: [say("好，换个事")] },
    ])
    const first = await drain(runLoop(config(lowering, log, { input: "上线" })))
    expect(first.result.status).toBe("paused")
    const ac = new AbortController()
    ac.abort(new RunStop("user"))
    const stopped = await drain(runLoop(config(lowering, log, { signal: ac.signal })))
    expect(stopped.result.status).toBe("paused")
    const third = await drain(runLoop(config(lowering, log, { input: "算了，换个事" })))
    expect(third.result.status).toBe("done")
    expect((await all(log)).some((e) => e.type === "core.handoff")).toBe(false)
  })
})
