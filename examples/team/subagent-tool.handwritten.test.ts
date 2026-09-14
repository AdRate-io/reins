/**
 * 手写范式（对照版）的五件事，用脚本化降级层逐条验证（机制正确性；行为正确性看 recordings/ 里的真模型录像）。
 * 示例实际用的 asTool 版本的用例在 packages/agent/src/as-tool.test.ts。
 */
import { ScriptedLowering, type ScriptedTurn } from "@reinsjs/core/testing"
import { type Agent, createAgent, defineTool, type Event, type RunResult, type ToRequestInput, memoryStore } from "@reinsjs/agent"
import { describe, expect, it } from "vitest"
import { childSessionsOf, type ExpertOutcome, expertTool } from "./subagent-tool.handwritten.ts"

const MODEL = { provider: "scripted", id: "s" }
const text = (t: string): ScriptedTurn => ({ drafts: [{ type: "core.model_text", actor: "model", payload: { text: t } }] })
const call = (id: string, name: string, args: unknown): ScriptedTurn => ({
  drafts: [{ type: "core.tool_call", actor: "model", payload: { toolCallId: id, name, args } }],
})

/** 一个专家：第一轮查 seen_principal 工具，第二轮作答。工具把 ctx.principal 记下来，用来验 ② */
function makeExpert(opts: { onTurn?: (turn: number) => void } = {}) {
  const seen: { principal?: unknown; sessionId?: string }[] = []
  const probe = defineTool<Record<string, never>>({
    name: "probe",
    description: "记录 principal",
    inputSchema: { type: "object", properties: {} },
    risk: "low",
    execute: (_i, ctx) => {
      seen.push({ principal: ctx.principal, sessionId: ctx.sessionId })
      return { ok: true }
    },
  })
  const lowering = new ScriptedLowering((_input: ToRequestInput, turn: number) => {
    opts.onTurn?.(turn)
    return turn === 0 ? call("c1", "probe", {}) : text("专家的答案")
  })
  const agent = createAgent({ model: { model: MODEL, lowering }, store: memoryStore(), tools: [probe] })
  return { agent, seen }
}

/** 编排者：第一轮叫专家，第二轮汇报 */
function makeLead(tool: ReturnType<typeof expertTool>, task = "帮我看看") {
  const lowering = new ScriptedLowering([call("p1", tool.name, { task }), text("汇报完毕")])
  return createAgent({ model: { model: MODEL, lowering }, store: memoryStore(), tools: [tool] })
}

async function drain(agent: Agent, opts: Parameters<Agent["run"]>[0]) {
  const events: Event[] = []
  const gen = agent.run(opts)
  let result: RunResult
  while (true) {
    const step = await gen.next()
    if (step.done) {
      result = step.value
      break
    }
    events.push(step.value)
  }
  return { events, result }
}

const outcomeOf = (events: Event[], name: string): ExpertOutcome => {
  const found = childSessionsOf(events, new Set([name]))
  expect(found).toHaveLength(1)
  return found[0] as ExpertOutcome
}

describe("子代理即工具（examples/team/subagent-tool.ts）", () => {
  it("② principal 原样下传；③ 子会话 sessionId 写进父 tool_result；④ 子用量汇总在结果里；子会话确实独立", async () => {
    const expert = makeExpert()
    const tool = expertTool({ name: "ask_expert", role: "expert", agent: expert.agent, description: "问专家" })
    const lead = makeLead(tool)
    const { events, result } = await drain(lead, { principal: { id: "boss", tenant: "t1" } })
    expect(result.status).toBe("done")

    const outcome = outcomeOf(events, "ask_expert")
    expect(outcome.status).toBe("done")
    expect(outcome.answer).toBe("专家的答案")
    // ② 专家工具里看到的是同一个 principal
    expect(expert.seen).toEqual([{ principal: { id: "boss", tenant: "t1" }, sessionId: outcome.childSessionId }])
    // ③ 子会话与父会话不是同一个
    expect(outcome.childSessionId).not.toBe(result.sessionId)
    // ④ 脚本化降级层每次请求 input 10 / output 5，专家跑了两轮
    expect(outcome.usage).toEqual({ requests: 2, input: 20, output: 10, cacheRead: 0, cacheWrite: 0, toolCalls: 1 })
    // 子会话的事件不出现在父时间线里（子 run 有自己的日志）
    expect(events.every((e) => e.sessionId === result.sessionId)).toBe(true)
    const childLog = await collectLog(expert.agent, outcome.childSessionId)
    expect(childLog.map((e) => e.type)).toContain("core.tool_result")
    expect(childLog.every((e) => e.sessionId === outcome.childSessionId)).toBe(true)
  })

  it("① linked：父中止时子一起停 —— 子 paused(host)，工具以 isError 如实上报，父随后 paused(host)", async () => {
    const ac = new AbortController()
    // 专家第一轮开始时，模拟宿主中止父 run
    const expert = makeExpert({ onTurn: (turn) => turn === 0 && ac.abort() })
    const tool = expertTool({ name: "ask_expert", role: "expert", agent: expert.agent, description: "问专家", abort: "linked" })
    const { events, result } = await drain(makeLead(tool), { signal: ac.signal })

    const outcome = outcomeOf(events, "ask_expert")
    expect(outcome.status).toBe("paused")
    expect(outcome.detail).toMatch(/aborted by the host/)
    expect((events.find((e) => e.type === "core.tool_result")?.payload as { isError: boolean }).isError).toBe(true)
    // 子只跑了第一轮（工具调用），没来得及作答
    expect(outcome.usage.requests).toBe(1)
    expect(result.status).toBe("paused")
    expect(result.status === "paused" && result.reason).toBe("host")
  })

  it("① detached：父中止时子做完为止 —— 子 done、答案完整落进父日志，父才 paused(host)", async () => {
    const ac = new AbortController()
    const expert = makeExpert({ onTurn: (turn) => turn === 0 && ac.abort() })
    const tool = expertTool({ name: "ask_expert", role: "expert", agent: expert.agent, description: "问专家", abort: "detached" })
    const { events, result } = await drain(makeLead(tool), { signal: ac.signal })

    const outcome = outcomeOf(events, "ask_expert")
    expect(outcome.status).toBe("done")
    expect(outcome.answer).toBe("专家的答案")
    expect(outcome.usage.requests).toBe(2)
    // 父：结果已落，下一轮开头才按 signal 暂停
    expect(result.status).toBe("paused")
    expect(result.status === "paused" && result.reason).toBe("host")
  })

  it("⑤ 子要审批时不替人批：工具 isError 说明有 pending 审批，父模型自己决定；子会话留在 paused 状态", async () => {
    const seen: unknown[] = []
    const risky = defineTool<Record<string, never>>({
      name: "delete_all",
      description: "危险",
      inputSchema: { type: "object", properties: {} },
      needsApproval: true,
      execute: () => {
        seen.push(1)
        return { ok: true }
      },
    })
    const lowering = new ScriptedLowering([call("c1", "delete_all", {}), text("不该到这")])
    const expert = createAgent({ model: { model: MODEL, lowering }, store: memoryStore(), tools: [risky] })
    const tool = expertTool({ name: "ask_expert", role: "expert", agent: expert, description: "问专家" })
    const { events, result } = await drain(makeLead(tool), {})

    const outcome = outcomeOf(events, "ask_expert")
    expect(outcome.status).toBe("paused")
    expect(outcome.detail).toMatch(/needs human approval \(1 pending\)/)
    expect(seen).toEqual([]) // 没人替批，危险工具没执行
    expect(result.status).toBe("done") // 父模型看到 isError 后自己决定怎么汇报
  })

  it("入参校验：task 为空不跑子会话，结果是普通 isError 文本，childSessionsOf 不会把它误认成子会话", async () => {
    const expert = makeExpert()
    const tool = expertTool({ name: "ask_expert", role: "expert", agent: expert.agent, description: "问专家" })
    const { events } = await drain(makeLead(tool, "   "), {})
    expect(childSessionsOf(events, new Set(["ask_expert"]))).toEqual([])
    expect(expert.seen).toEqual([])
    const tr = events.find((e) => e.type === "core.tool_result")?.payload as { isError: boolean; content: { text?: string }[] }
    expect(tr.isError).toBe(true)
    expect(tr.content[0]?.text).toMatch(/task 必须是非空字符串/)
  })
})

async function collectLog(agent: Agent, sessionId: string): Promise<Event[]> {
  const out: Event[] = []
  for await (const e of agent.definition.log.read(sessionId)) out.push(e)
  return out
}
