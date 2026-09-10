/**
 * asTool（§10.1）：审批冒泡与预算合算用脚本化降级层验机制；行为正确性看 examples/team 的真模型录像。
 * 父子两个 agent 共用一套存储；"换进程"用新建 agent 实例（脚本从头）+ 同一存储来模拟。
 */
import { callTool, ScriptedLowering, type ScriptedTurn, say } from "@reins/core/testing"
import { describe, expect, it } from "vitest"
import {
  type Agent,
  type ApprovalDecisionInput,
  asTool,
  type CoreEventOf,
  createAgent,
  defineTool,
  type Event,
  memoryStore,
  type RunResult,
  type Socket,
  type Stores,
  type SubagentOutcome,
  subagentOutcomesOf,
} from "./index.js"

const MODEL = { provider: "scripted", id: "s" }
const turn = (...drafts: ScriptedTurn["drafts"][number][]): ScriptedTurn => ({ drafts })

const deploy = defineTool<{ env: string }>({
  name: "deploy",
  description: "上线",
  inputSchema: { type: "object", properties: { env: { type: "string" } } },
  needsApproval: true,
  execute: ({ env }) => `deployed ${env}`,
})
const lookup = defineTool<Record<string, never>>({
  name: "lookup",
  description: "查",
  inputSchema: { type: "object", properties: {} },
  execute: () => 42,
})

function expert(store: Stores, turns: ScriptedTurn[], tools = [deploy]): Agent {
  return createAgent({ model: { model: MODEL, lowering: new ScriptedLowering(turns) }, store, tools })
}
function lead(
  store: Stores,
  turns: ScriptedTurn[],
  child: Agent,
  extra: { sockets?: Socket[]; childSessionId?: () => string } = {},
): Agent {
  return createAgent({
    model: { model: MODEL, lowering: new ScriptedLowering(turns) },
    store,
    tools: [
      asTool(child, {
        name: "ask_expert",
        description: "问专家",
        role: "expert",
        ...(extra.childSessionId ? { childSessionId: extra.childSessionId } : {}),
      }),
    ],
    ...(extra.sockets ? { sockets: extra.sockets } : {}),
  })
}

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<{ events: Event[]; result: RunResult }> {
  const events: Event[] = []
  while (true) {
    const step = await gen.next()
    if (step.done) return { events, result: step.value }
    events.push(step.value)
  }
}
async function all(store: Stores, sessionId: string): Promise<Event[]> {
  const out: Event[] = []
  for await (const e of store.log.read(sessionId)) out.push(e)
  return out
}
const types = (events: readonly Event[]) => events.map((e) => e.type.replace("core.", ""))
const outcomeOf = (events: readonly Event[]): SubagentOutcome => {
  const found = subagentOutcomesOf(events, new Set(["ask_expert"]))
  expect(found).toHaveLength(1)
  return found[0] as SubagentOutcome
}

describe("asTool：审批冒泡", () => {
  it("子等审批 → 父整体 paused(kind=subagent)，父日志无 tool_result；换进程续跑：结论带子 sessionId 下传，子先续跑、父再拿结果", async () => {
    const store = memoryStore()
    const principal = { id: "boss" }
    const l1 = lead(
      store,
      [turn(callTool("p1", "ask_expert", { task: "deploy prod" })), turn(say("汇报"))],
      expert(store, [turn(callTool("c1", "deploy", { env: "prod" })), turn(say("deployed, all good"))]),
    )
    const first = await drain(l1.run({ input: "上线", principal }))
    expect(first.result.status).toBe("paused")
    if (first.result.status !== "paused") return
    const sid = first.result.sessionId
    const childId = `${sid}:p1`
    expect(first.result.reason).toBe("approval")
    expect(first.result.interruptions).toHaveLength(1)
    const sub = first.result.interruptions[0]
    expect(sub?.kind).toBe("subagent")
    if (sub?.kind !== "subagent") return
    expect(sub).toMatchObject({
      toolCallId: "p1",
      call: { name: "ask_expert", args: { task: "deploy prod" } },
      childSessionId: childId,
      reason: "approval",
      interruptions: [
        { kind: "approval", toolCallId: "c1", call: { name: "deploy", args: { env: "prod" } } },
      ],
    })
    expect(sub.state.sessionId).toBe(childId)
    expect(sub.state.pendingToolCallIds).toEqual(["c1"])
    // 父：调用留作 pending；子：等审批
    expect(types(await all(store, sid))).toEqual([
      "tools_bound",
      "user_message",
      "tool_call",
      "budget_usage",
      "run_paused",
    ])
    expect(types(await all(store, childId))).toEqual([
      "tools_bound",
      "user_message",
      "tool_call",
      "approval_request",
      "budget_usage",
      "run_paused",
    ])
    // 子会话拿到的是父的 principal（身份下传）
    const childUser = (await all(store, childId))[1] as CoreEventOf<"core.user_message">
    expect(childUser.payload.content).toEqual([{ type: "text", text: "deploy prod" }])

    // 换进程：新实例、同一存储、脚本从头（专家剩一轮：作答；编排者剩一轮：汇报）
    const l2 = lead(store, [turn(say("汇报"))], expert(store, [turn(say("deployed, all good"))]))
    const decision: ApprovalDecisionInput = {
      toolCallId: "c1",
      sessionId: childId,
      approved: true,
      by: "boss",
    }
    const second = await drain(
      l2.run({ sessionId: sid, resume: first.result.state, decisions: [decision], principal }),
    )
    expect(second.result.status).toBe("done")
    // 子：结论入账 → 补齐 deploy → 作答
    expect(types(await all(store, childId)).slice(6)).toEqual([
      "approval_decision",
      "tools_bound",
      "tool_result",
      "model_text",
      "budget_usage",
    ])
    const childDecision = (await all(store, childId))[6] as CoreEventOf<"core.approval_decision">
    expect(childDecision.payload).toEqual({ toolCallId: "c1", approved: true, by: "boss" })
    // 父：run_resumed → 补齐 p1（拿到子的最终结果）→ 汇报；父日志里没有子的 approval_decision
    const parent = await all(store, sid)
    expect(types(parent).slice(5)).toEqual([
      "run_resumed",
      "tools_bound",
      "tool_result",
      "model_text",
      "budget_usage",
    ])
    expect(parent.some((e) => e.type === "core.approval_decision")).toBe(false)
    const outcome = outcomeOf(parent)
    expect(outcome).toMatchObject({
      role: "expert",
      childSessionId: childId,
      status: "done",
      answer: "deployed, all good",
    })
    // 用量从子会话时间线算：两次请求（10/5 各一次）、一次工具调用，含续跑之前的那次
    expect(outcome.usage).toEqual({
      requests: 2,
      input: 20,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      toolCalls: 1,
    })
  })

  it("拒绝：子的调用记为审批被拒绝，专家照常作答，父拿到 done 的结果", async () => {
    const store = memoryStore()
    const l1 = lead(
      store,
      [turn(callTool("p1", "ask_expert", { task: "deploy prod" })), turn(say("汇报"))],
      expert(store, [turn(callTool("c1", "deploy", { env: "prod" }))]),
    )
    const first = await drain(l1.run({ input: "上线" }))
    if (first.result.status !== "paused") throw new Error("unreachable")
    const sid = first.result.sessionId
    const l2 = lead(store, [turn(say("汇报"))], expert(store, [turn(say("cannot deploy: denied"))]))
    const second = await drain(
      l2.run({
        sessionId: sid,
        resume: first.result.state,
        decisions: [
          { toolCallId: "c1", sessionId: `${sid}:p1`, approved: false, by: "boss", reason: "太晚了" },
        ],
      }),
    )
    expect(second.result.status).toBe("done")
    const childResult = (await all(store, `${sid}:p1`)).find(
      (e) => e.type === "core.tool_result",
    ) as CoreEventOf<"core.tool_result">
    expect(childResult.payload.isError).toBe(true)
    expect((childResult.payload.content[0] as { text: string }).text).toContain("太晚了")
    expect(outcomeOf(await all(store, sid))).toMatchObject({
      status: "done",
      answer: "cannot deploy: denied",
    })
  })
})

describe("asTool：预算合算与多轮", () => {
  it("子的每次模型请求经 ctx.spend 计入父 run 的 tokensSpent；父自己的 budget_usage 不掺子用量", async () => {
    const store = memoryStore()
    const spy: number[] = []
    const probe: Socket = {
      name: "probe",
      onTurnEnd: (ctx) => {
        spy.push(ctx.budget.tokensSpent)
        return undefined
      },
    }
    const l = lead(
      store,
      [turn(callTool("p1", "ask_expert", { task: "查" })), turn(say("汇报"))],
      expert(store, [turn(callTool("c1", "lookup", {})), turn(say("42"))], [lookup]),
      { sockets: [probe] },
    )
    const r = await drain(l.run({ input: "去" }))
    expect(r.result.status).toBe("done")
    // 脚本化降级层每次请求 10/5：父第一轮 15 + 子两轮 30 = 45；父第二轮再 +15
    expect(spy).toEqual([45, 60])
    const parentUsages = r.events.filter(
      (e) => e.type === "core.budget_usage",
    ) as CoreEventOf<"core.budget_usage">[]
    expect(parentUsages.map((u) => u.payload.tokens)).toEqual([
      { input: 10, output: 5 },
      { input: 10, output: 5 },
    ])
  })

  it("自定义 childSessionId 指向同一会话：第二次调用是同一个专家的新一轮，不是续跑", async () => {
    const store = memoryStore()
    const l = lead(
      store,
      [
        turn(callTool("p1", "ask_expert", { task: "第一问" })),
        turn(callTool("p2", "ask_expert", { task: "第二问" })),
        turn(say("汇报")),
      ],
      expert(store, [turn(say("答一")), turn(say("答二"))], [lookup]),
      { childSessionId: () => "expert-1" },
    )
    const r = await drain(l.run({ input: "去" }))
    expect(r.result.status).toBe("done")
    const child = await all(store, "expert-1")
    expect(types(child).filter((t) => t === "user_message")).toHaveLength(2)
    const outcomes = subagentOutcomesOf(r.events, new Set(["ask_expert"]))
    expect(outcomes.map((o) => [o.childSessionId, o.answer])).toEqual([
      ["expert-1", "答一"],
      ["expert-1", "答二"],
    ])
  })
})
