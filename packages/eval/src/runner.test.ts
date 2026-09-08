/**
 * 运行器端到端：用脚本化降级层当"模型"。剧本是输入的函数（看视图决定说什么），
 * 所以同一个剧本能跨臂、跨格、跨探针复用，不依赖全局轮计数。
 */
import { compact } from "@reins/brain"
import {
  type CoreEventOf,
  createCoreEvent,
  createCoreRegistry,
  defineTool,
  type Event,
  type Lowering,
  type Tool,
  type ToRequestInput,
} from "@reins/core"
import { callTool, type Script, ScriptedLowering, say } from "@reins/core/testing"
import { describe, expect, it } from "vitest"
import { noneArm, thresholdArm } from "./arms.js"
import { checkGate } from "./gate.js"
import { renderReport } from "./report.js"
import { probeAnswerOf, runEval, summarize } from "./runner.js"
import type { EvalArm, EvalFixture, EvalOutcome } from "./types.js"

const MODEL = { provider: "scripted", id: "scripted" }

function deterministic() {
  let t = 1_800_000_000_000
  let n = 0
  return { now: () => (t += 1000), newId: () => `id${++n}` }
}

const lastUserText = (input: ToRequestInput): string => {
  const u = [...input.events].reverse().find((e) => e.type === "core.user_message") as
    | CoreEventOf<"core.user_message">
    | undefined
  return u?.payload.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? ""
}
const visibleMentions = (input: ToRequestInput, needle: string) =>
  input.events.some((e) => JSON.stringify(e.payload).includes(needle))

/** 长一点的工具结果，让缩到几百 token 的窗口能触发阈值裁剪 */
const CODE_RESULT = `${"padding ".repeat(120)} the secret code is 4711`

const lookup: Tool = defineTool<{ key: string }>({
  name: "lookup",
  description: "查一个键",
  inputSchema: { type: "object", properties: { key: { type: "string" } } },
  execute: ({ key }) => (key === "code" ? CODE_RESULT : "unknown key"),
})
const deploy: Tool = {
  name: "deploy",
  description: "上线",
  inputSchema: { type: "object" },
  needsApproval: true,
  execute: () => "deployed",
}

/** 找码剧本：先查、再汇报；被问 Q: 时只看视图里有没有 4711 */
const finder: Script = (input) => {
  const q = lastUserText(input)
  if (q.startsWith("Q:"))
    return { drafts: [say(visibleMentions(input, "4711") ? "The code is 4711." : "I don't know.")] }
  const hasResult = input.events.some((e) => e.type === "core.tool_result")
  if (!hasResult) return { drafts: [callTool(`c${input.events.length}`, "lookup", { key: "code" })] }
  return {
    drafts: [say("Done: the code is 4711.")],
    outcome: { usage: { input: 100, output: 10, cacheRead: 50 } },
  }
}

const fixture: EvalFixture = {
  id: "find-code",
  task: { input: "Find the code", systemPrompt: "You are a finder." },
  tools: [lookup],
  facts: [{ id: "code", question: "Q: what is the code?", expect: "4711" }],
  constraints: [
    { id: "no-deploy", violates: (a) => a.type === "core.tool_call" && a.payload.name === "deploy" },
  ],
  completion: (o) => o.finalText.startsWith("Done"),
}

describe("runEval：对照运行器", () => {
  it("两臂对照：无脑子全部可见、召回 1；纯阈值在窄窗口下折叠、记到 threshold 整理；报告与门禁可用", async () => {
    const lowering = new ScriptedLowering(finder)
    const cells: string[] = []
    const report = await runEval({
      fixtures: [{ ...fixture, contextWindow: 200 }],
      arms: [noneArm(), thresholdArm()],
      lowering,
      model: MODEL,
      ...deterministic(),
      onOutcome: (o) => cells.push(`${o.fixtureId}/${o.arm}#${o.repeat}`),
    })
    expect(cells).toEqual(["find-code/none#1", "find-code/threshold#1"])
    const [none, threshold] = report.outcomes
    if (!none || !threshold) throw new Error("unreachable")

    // 无脑子：跑完、完成、什么都没折、探针能看到工具结果
    expect(none.metrics.status).toBe("done")
    expect(none.metrics.completed).toBe(1)
    expect(none.metrics.compactions).toEqual({ model: 0, threshold: 0, maxConsecutive: 0 })
    expect(none.metrics.recall).toBe(1)
    expect(none.facts[0]).toMatchObject({
      id: "code",
      answer: "The code is 4711.",
      answerFrom: "text",
      score: 1,
      gradedBy: "expect",
    })
    expect(none.metrics.turns).toBe(2)
    expect(none.metrics.toolCalls).toBe(1)
    // 用量：两轮 = 缺省 10/5 + 剧本给的 100/10/50
    expect(none.metrics.tokens).toEqual({ input: 110, output: 15, cacheRead: 50, cacheWrite: 0, total: 175 })
    expect(none.metrics.cacheHitRate).toBeCloseTo(50 / 160)
    // 探针用量另记，不混进任务
    expect(none.metrics.probeTokens.total).toBeGreaterThan(0)
    expect(none.metrics.violations.before).toEqual({ actions: 2, violations: 0, rate: 0 })
    expect(none.metrics.wallMs).toBeGreaterThan(0)

    // 纯阈值：core 的 budgetTruncate 在窄窗口下出手，compaction 记在时间线里
    expect(threshold.metrics.status).toBe("done")
    expect(threshold.metrics.compactions.threshold).toBeGreaterThanOrEqual(1)
    expect(threshold.metrics.compactions.model).toBe(0)
    expect(typeof threshold.metrics.recall).toBe("number")
    // 主会话与探针会话都是独立 sessionId，探针没写回主会话
    expect(threshold.sessionIds).toHaveLength(1)
    expect(threshold.timeline.every((e) => e.sessionId === threshold.sessionIds[0])).toBe(true)
    expect(
      threshold.timeline.some(
        (e) => e.type === "core.user_message" && JSON.stringify(e.payload).includes("Q:"),
      ),
    ).toBe(false)

    // 汇总与门禁
    expect(Object.keys(report.summary)).toEqual(["none", "threshold"])
    expect(report.summary.none?.completion).toBe(1)
    const gate = checkGate(report, { reference: "threshold", candidate: "none" })
    expect(gate.checks.map((c) => c.name)).toEqual(["tokens", "completion", "recall", "governance"])
    expect(gate.checks.find((c) => c.name === "governance")?.pass).toBe(true)
    const md = renderReport(report, { gate, detail: true })
    expect(md).toContain("| none |")
    expect(md).toContain("| threshold |")
    expect(md).toContain("## 门禁")
    expect(md).toContain("## 明细")
  })

  it("模型自决臂：装 @reins/brain 的 compact 后，模型调 compact 工具记为 model 整理", async () => {
    const script: Script = (input) => {
      const q = lastUserText(input)
      if (q.startsWith("Q:")) return { drafts: [say(visibleMentions(input, "4711") ? "4711" : "unknown")] }
      const compacted = input.events.some((e) => e.type === "core.compaction")
      const hasResult = input.events.some((e) => e.type === "core.tool_result")
      if (!hasResult) return { drafts: [callTool("c1", "lookup", { key: "code" })] }
      if (!compacted) {
        return {
          drafts: [
            callTool("c2", "compact", { summary: "Looked up the code: it is 4711.", keep: ["code = 4711"] }),
          ],
        }
      }
      return { drafts: [say("Done: the code is 4711.")] }
    }
    const brain: EvalArm = { name: "brain", sockets: [compact()] }
    const report = await runEval({
      fixtures: [fixture],
      arms: [brain],
      lowering: new ScriptedLowering(script),
      model: MODEL,
      ...deterministic(),
    })
    const o = report.outcomes[0]
    if (!o) throw new Error("unreachable")
    expect(o.metrics.status).toBe("done")
    expect(o.metrics.compactions).toEqual({ model: 1, threshold: 0, maxConsecutive: 1 })
    expect(o.metrics.turns).toBe(3)
    // 整理摘要里带着 4711，探针（分叉会话）看得到
    expect(o.metrics.recall).toBe(1)
    expect(o.metrics.completed).toBe(1)
  })

  it("审批：fixture.approve 代人回答，拒绝的调用模型看到被拒结果；决策记为 approval_decision(by=eval)", async () => {
    const script: Script = (input) => {
      const hasDeployResult = input.events.some(
        (e) =>
          e.type === "core.tool_result" && (e as CoreEventOf<"core.tool_result">).payload.name === "deploy",
      )
      if (!hasDeployResult) return { drafts: [callTool("d1", "deploy", { env: "prod" })] }
      return { drafts: [say("Done: deploy was rejected, stopping.")] }
    }
    const report = await runEval({
      fixtures: [
        {
          id: "deploy",
          task: { input: "ship it" },
          tools: [deploy],
          completion: (o) => o.finalText.startsWith("Done"),
          approve: (i) => i.call.name !== "deploy",
          constraints: fixture.constraints ?? [],
        },
      ],
      arms: [thresholdArm()],
      lowering: new ScriptedLowering(script),
      model: MODEL,
      ...deterministic(),
    })
    const o = report.outcomes[0]
    if (!o) throw new Error("unreachable")
    expect(o.metrics.status).toBe("done")
    expect(o.metrics.completed).toBe(1)
    const decision = o.timeline.find((e) => e.type === "core.approval_decision") as
      | CoreEventOf<"core.approval_decision">
      | undefined
    expect(decision?.payload).toMatchObject({ approved: false, by: "eval" })
    expect(o.timeline.filter((e) => e.type === "core.run_paused")).toHaveLength(1)
    // 约束违规：调了 deploy 就算违规（哪怕被拒）
    expect(o.metrics.violations.before.violations).toBe(1)
  })

  it("预算暂停：缺省不续跑、状态 paused、完成 0；maxResumes 给几次就续几次", async () => {
    const forever: Script = (input) => ({
      drafts: [callTool(`c${input.events.length}`, "lookup", { key: "x" })],
    })
    const base: EvalFixture = {
      id: "loop",
      task: { input: "go" },
      tools: [lookup],
      completion: () => false,
      maxTurns: 2,
    }
    const r1 = await runEval({
      fixtures: [base],
      arms: [thresholdArm()],
      lowering: new ScriptedLowering(forever),
      model: MODEL,
      ...deterministic(),
    })
    expect(r1.outcomes[0]?.metrics.status).toBe("paused")
    expect(r1.outcomes[0]?.metrics.turns).toBe(2)
    expect(r1.outcomes[0]?.metrics.repeatedToolCalls).toBe(1)
    expect(r1.summary.threshold?.finishedRate).toBe(0)

    const r2 = await runEval({
      fixtures: [{ ...base, maxResumes: 2 }],
      arms: [thresholdArm()],
      lowering: new ScriptedLowering(forever),
      model: MODEL,
      ...deterministic(),
    })
    const o = r2.outcomes[0]
    if (!o) throw new Error("unreachable")
    expect(o.metrics.status).toBe("paused")
    expect(o.timeline.filter((e) => e.type === "core.run_resumed")).toHaveLength(2)
    expect(o.metrics.turns).toBe(6)
  })

  it("种子历史：换 sessionId 后原样进日志；seq 不从 1 起连续则开跑前报错", async () => {
    const registry = createCoreRegistry()
    const seed: Event[] = [
      createCoreEvent(registry, {
        sessionId: "old",
        seq: 1,
        at: 1,
        type: "core.user_message",
        actor: "user",
        payload: { content: [{ type: "text", text: "earlier: the code is 4711" }] },
      }),
      createCoreEvent(registry, {
        sessionId: "old",
        seq: 2,
        at: 2,
        type: "core.model_text",
        actor: "model",
        payload: { text: "noted" },
      }),
    ]
    const script: Script = (input) => {
      const q = lastUserText(input)
      if (q.startsWith("Q:")) return { drafts: [say(visibleMentions(input, "4711") ? "4711" : "?")] }
      return { drafts: [say("Done")] }
    }
    const report = await runEval({
      fixtures: [{ ...fixture, tools: [], task: { input: "continue", seed } }],
      arms: [thresholdArm()],
      lowering: new ScriptedLowering(script),
      model: MODEL,
      ...deterministic(),
    })
    const o = report.outcomes[0]
    if (!o) throw new Error("unreachable")
    expect(o.timeline.slice(0, 2).map((e) => e.seq)).toEqual([1, 2])
    expect(o.timeline[0]?.sessionId).toBe(o.sessionIds[0])
    expect(o.timeline[0]?.id).toBe(seed[0]?.id)
    expect(o.metrics.recall).toBe(1)

    await expect(
      runEval({
        fixtures: [{ ...fixture, task: { input: "x", seed: [seed[1] as Event] } }],
        arms: [thresholdArm()],
        lowering: new ScriptedLowering(script),
        model: MODEL,
      }),
    ).rejects.toThrow(/seq 必须从 1 起连续/)
  })

  it("配置错误在开跑前报：事实没 expect 也没 judge、臂名重复；有 judge 时用 judge 打分", async () => {
    let called = 0
    const neverCalled: Lowering = {
      capabilities: () => {
        called++
        return new ScriptedLowering([]).capabilities(MODEL)
      },
      toRequest: () => {
        throw new Error("不该被调用")
      },
      // biome-ignore lint/correctness/useYield: 故意不产出
      async *stream() {
        throw new Error("不该被调用")
      },
    }
    const noExpect: EvalFixture = { ...fixture, facts: [{ id: "f", question: "Q: code?" }] }
    await expect(
      runEval({ fixtures: [noExpect], arms: [thresholdArm()], lowering: neverCalled, model: MODEL }),
    ).rejects.toThrow(/没有 expect/)
    await expect(
      runEval({
        fixtures: [fixture],
        arms: [thresholdArm(), thresholdArm()],
        lowering: neverCalled,
        model: MODEL,
      }),
    ).rejects.toThrow(/臂名重复/)
    expect(called).toBe(0)

    const judged: string[] = []
    const report = await runEval({
      fixtures: [noExpect],
      arms: [noneArm()],
      lowering: new ScriptedLowering(finder),
      model: MODEL,
      judge: ({ answer }) => {
        judged.push(answer)
        return 0.5
      },
      ...deterministic(),
    })
    expect(judged).toEqual(["The code is 4711."])
    expect(report.outcomes[0]?.facts[0]).toMatchObject({ score: 0.5, gradedBy: "judge" })
    expect(report.outcomes[0]?.metrics.recall).toBe(0.5)
  })

  it("probeAnswerOf：有正文取正文；正文为空退回最后一段 thinking；都没有为 none", () => {
    const reg = createCoreRegistry()
    const mk = (type: "core.model_text" | "core.model_thinking", text: string, seq: number): Event =>
      createCoreEvent(reg, {
        type,
        actor: "model",
        payload: { text },
        sessionId: "p",
        seq,
        at: seq,
        id: `p${seq}`,
      })
    expect(probeAnswerOf([mk("core.model_thinking", "14", 1), mk("core.model_text", "fourteen", 2)])).toEqual(
      {
        answer: "fourteen",
        answerFrom: "text",
      },
    )
    expect(probeAnswerOf([mk("core.model_thinking", "14", 1), mk("core.model_thinking", "", 2)])).toEqual({
      answer: "14",
      answerFrom: "thinking",
    })
    expect(probeAnswerOf([])).toEqual({ answer: "", answerFrom: "none" })
  })

  it("repeatStart：补跑时从指定编号起，不盖掉已有的格", async () => {
    const report = await runEval({
      fixtures: [{ ...fixture, facts: [] }],
      arms: [noneArm()],
      lowering: new ScriptedLowering(finder),
      model: MODEL,
      repeats: 2,
      repeatStart: 3,
      ...deterministic(),
    })
    expect(report.outcomes.map((o) => o.repeat)).toEqual([3, 4])
  })

  it("种子历史不计入指标：token、轮、动作只算本次新追加的事件；完成判定仍能看全链", async () => {
    const seed: Event[] = [
      createCoreEvent(createCoreRegistry(), {
        type: "core.user_message",
        actor: "user",
        payload: { content: [{ type: "text", text: "earlier task" }] },
        sessionId: "old",
        seq: 1,
        at: 1,
        id: "s1",
      }),
      createCoreEvent(createCoreRegistry(), {
        type: "core.model_text",
        actor: "model",
        payload: { text: "earlier answer: the code is 4711" },
        sessionId: "old",
        seq: 2,
        at: 2,
        id: "s2",
      }),
      createCoreEvent(createCoreRegistry(), {
        type: "core.budget_usage",
        actor: "system",
        payload: { tokens: { input: 99_999, output: 1 }, toolCalls: 0, wallMs: 1 },
        sessionId: "old",
        seq: 3,
        at: 3,
        id: "s3",
      }),
    ]
    const report = await runEval({
      fixtures: [
        {
          ...fixture,
          task: { ...fixture.task, seed },
          facts: [],
          completion: (o) => o.timeline.length > o.fresh.length && o.finalText.startsWith("Done"),
        },
      ],
      arms: [noneArm()],
      lowering: new ScriptedLowering(finder),
      model: MODEL,
      ...deterministic(),
    })
    const m = report.outcomes[0]?.metrics
    expect(m?.completed).toBe(1)
    expect(m?.tokens.input).toBe(110)
    expect(m?.turns).toBe(2)
    expect(m?.violations.before.actions).toBe(2)
    expect(report.outcomes[0]?.timeline.slice(0, 3).map((e) => e.id)).toEqual(["s1", "s2", "s3"])
  })

  it("summarize：按臂取均值，recall / cacheHitRate 只在有值时给", () => {
    const mk = (arm: string, completed: number, total: number, recall?: number): EvalOutcome => ({
      fixtureId: "f",
      arm,
      repeat: 1,
      sessionIds: [],
      timelines: [],
      timeline: [],
      fresh: [],
      result: { status: "done" as const, sessionId: "s", lastSeq: 0 },
      finalText: "",
      facts: [],
      metrics: {
        status: "done" as const,
        completed,
        tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
        turns: 1,
        toolCalls: 0,
        toolErrors: 0,
        repeatedToolCalls: 0,
        compactions: { model: 0, threshold: 0, maxConsecutive: 0 },
        violations: {
          before: { actions: 1, violations: 0, rate: 0 },
          after: { actions: 0, violations: 0, rate: 0 },
        },
        ...(recall !== undefined ? { recall } : {}),
        wallMs: 10,
        probeTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    })
    const s = summarize([mk("a", 1, 100, 1), mk("a", 0, 300, 0), mk("b", 1, 50)])
    expect(s.a).toMatchObject({ runs: 2, completion: 0.5, recall: 0.5, finishedRate: 1 })
    expect(s.a?.tokens.total).toBe(200)
    expect(s.a?.cacheHitRate).toBe(0)
    expect(s.b?.recall).toBeUndefined()
  })
})
