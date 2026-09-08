import { describe, expect, it } from "vitest"
import type { Event } from "../events/base.js"
import type { CoreEvent, CoreEventOf } from "../events/core.js"
import { createCoreEvent } from "../events/create.js"
import { createCoreRegistry } from "../events/registry.js"
import { project } from "../projection/project.js"
import { InMemoryEventLog } from "../store/in-memory.js"
import { callTool, ScriptedLowering, type ScriptedTurn, say, think } from "../testing/scripted-lowering.js"
import { BUILTIN_APPROVAL_POLICY, runLoop } from "./run-loop.js"
import { defineTool } from "./tools.js"
import type { LoopConfig, RunResult, Socket, Tool } from "./types.js"

const registry = createCoreRegistry()
const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"

/** 确定性时钟与 id：每次调用 +1 毫秒，id 以调用序号命名 */
function deterministic() {
  let t = 1_800_000_000_000
  let n = 0
  return { now: () => ++t, newId: () => `id${++n}` }
}

const addTool = defineTool<{ a: number; b: number }>({
  name: "add",
  description: "两数相加",
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  execute: ({ a, b }) => a + b,
})

/** 跑到底，收集 yield 出的事件与最终结果 */
async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<{ events: Event[]; result: RunResult }> {
  const events: Event[] = []
  while (true) {
    const step = await gen.next()
    if (step.done) return { events, result: step.value }
    events.push(step.value)
  }
}

async function all(log: InMemoryEventLog, sessionId = SESSION): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(sessionId)) out.push(e as CoreEvent)
  return out
}

const types = (events: readonly Event[]) => events.map((e) => e.type.replace("core.", ""))

function baseConfig(
  lowering: ScriptedLowering,
  log: InMemoryEventLog,
  extra: Partial<LoopConfig> = {},
): LoopConfig {
  return { sessionId: SESSION, log, lowering, model: MODEL, tools: [addTool], ...deterministic(), ...extra }
}

/** 三轮剧本：想 → 调工具 → 再调工具 → 回答 */
const THREE_TURNS: ScriptedTurn[] = [
  { drafts: [think("先算 2+3"), callTool("c1", "add", { a: 2, b: 3 })] },
  { drafts: [callTool("c2", "add", { a: 5, b: 4 })] },
  { drafts: [say("答案是 9")] },
]

describe("runLoop：带工具的 agent 跑三轮并结束", () => {
  it("日志顺序、结果四态之 done、yield 与日志一致", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering(THREE_TURNS)
    const { events, result } = await drain(
      runLoop(baseConfig(lowering, log, { input: "2+3 再加 4 等于几？" })),
    )

    expect(result).toEqual({ status: "done", sessionId: SESSION, lastSeq: 10 })
    const logged = await all(log)
    expect(types(logged)).toEqual([
      "user_message",
      "model_thinking",
      "tool_call",
      "tool_result",
      "budget_usage",
      "tool_call",
      "tool_result",
      "budget_usage",
      "model_text",
      "budget_usage",
    ])
    // 时间线上的每一条都经 yield 交给了宿主，顺序与 seq 一致
    expect(events.map((e) => e.seq)).toEqual(logged.map((e) => e.seq))
    expect(logged.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it("工具结果带因果链、来源与 untrusted，且答案正确", async () => {
    const log = new InMemoryEventLog()
    const { result } = await drain(
      runLoop(baseConfig(new ScriptedLowering(THREE_TURNS), log, { input: "算" })),
    )
    expect(result.status).toBe("done")
    const logged = await all(log)
    const call = logged.find((e) => e.type === "core.tool_call") as CoreEventOf<"core.tool_call">
    const res = logged.find((e) => e.type === "core.tool_result") as CoreEventOf<"core.tool_result">
    expect(res.parentId).toBe(call.id)
    expect(res.actor).toBe("tool")
    expect(res.trust).toBe("untrusted")
    expect(res.provenance).toEqual({ source: "add" })
    expect(res.payload).toEqual({
      toolCallId: "c1",
      name: "add",
      content: [{ type: "text", text: "5" }],
      isError: false,
    })
    const second = logged.filter((e) => e.type === "core.tool_result")[1] as CoreEventOf<"core.tool_result">
    expect(second.payload.content).toEqual([{ type: "text", text: "9" }])
  })

  it("模型每轮看到的正是日志的投影：日志可完整回放", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering(THREE_TURNS)
    await drain(runLoop(baseConfig(lowering, log, { input: "算" })))
    const logged = await all(log)

    expect(lowering.requests).toHaveLength(3)
    // 第 n 轮模型看到的 = 该轮请求前日志前缀的投影（运维事件如 budget_usage 不给模型看）
    const seen = lowering.requests.map((r) => r.events.map((e) => e.id))
    const prefixAt = (seq: number) =>
      project({
        timeline: logged.filter((e) => e.seq <= seq),
        sessionId: SESSION,
        budget: { contextLimit: 200_000 },
      })
    expect(seen[0]).toEqual(prefixAt(1).events.map((e) => e.id))
    expect(seen[1]).toEqual(prefixAt(5).events.map((e) => e.id))
    expect(seen[2]).toEqual(prefixAt(8).events.map((e) => e.id))
    // 每轮工具声明也到位
    expect(lowering.requests[0]?.tools?.map((t) => t.name)).toEqual(["add"])

    // 只凭日志重放整段对话：可见事件依次为 用户 → 想 → 调 → 果 → 调 → 果 → 答
    const replay = project({ timeline: logged, sessionId: SESSION, budget: { contextLimit: 200_000 } })
    expect(types(replay.events)).toEqual([
      "user_message",
      "model_thinking",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "model_text",
    ])
    expect(replay.emitted).toEqual([])
    // thinking 的回放数据原样落日志
    expect(replay.events[1]?.replay).toMatchObject({ thinkingSignature: "sig:先算 2+3" })
  })

  it("budget_usage 记录每轮用量与工具次数", async () => {
    const log = new InMemoryEventLog()
    await drain(runLoop(baseConfig(new ScriptedLowering(THREE_TURNS), log, { input: "算" })))
    const usages = (await all(log)).filter(
      (e): e is CoreEventOf<"core.budget_usage"> => e.type === "core.budget_usage",
    )
    expect(usages.map((u) => u.payload.toolCalls)).toEqual([1, 1, 0])
    expect(usages[0]?.payload.tokens).toEqual({ input: 10, output: 5 })
    expect(usages.every((u) => u.payload.wallMs >= 0)).toBe(true)
  })

  it("同样的输入、同样的时钟与 id 工厂，两次运行日志逐字相同", async () => {
    const run = async () => {
      const log = new InMemoryEventLog()
      await drain(runLoop(baseConfig(new ScriptedLowering(THREE_TURNS), log, { input: "算" })))
      return all(log)
    }
    expect(await run()).toEqual(await run())
  })

  it("流式增量经 onDelta 给 UI", async () => {
    const deltas: string[] = []
    const log = new InMemoryEventLog()
    await drain(
      runLoop(
        baseConfig(new ScriptedLowering(THREE_TURNS), log, {
          input: "算",
          onDelta: (d) => deltas.push(d.delta),
        }),
      ),
    )
    expect(deltas).toEqual(["答案是 9"])
  })
})

describe("runLoop：Socket 五个钩子", () => {
  it("按注册顺序调用，beforeModel 注入的 system_note 本轮即可见且入日志", async () => {
    const trace: string[] = []
    const socket: Socket = {
      name: "tracer",
      beforeModel(ctx) {
        trace.push(`beforeModel@${ctx.session.turn}`)
        if (ctx.session.turn === 1) {
          ctx.emit({
            type: "core.system_note",
            actor: "system",
            payload: { kind: "perception", text: "上下文 <50%" },
          })
        }
        return undefined
      },
      afterModel(_ctx, events) {
        trace.push(`afterModel:${types(events).join("+")}`)
      },
      beforeTool(_ctx, call) {
        trace.push(`beforeTool:${call.payload.toolCallId}`)
        return "proceed"
      },
      afterTool(_ctx, call) {
        trace.push(`afterTool:${call.payload.toolCallId}`)
        return undefined
      },
      onTurnEnd(ctx) {
        trace.push(`onTurnEnd@${ctx.session.turn}`)
        return undefined
      },
    }
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering(THREE_TURNS)
    const { result } = await drain(runLoop(baseConfig(lowering, log, { input: "算", sockets: [socket] })))
    expect(result.status).toBe("done")
    expect(trace).toEqual([
      "beforeModel@1",
      "afterModel:model_thinking+tool_call",
      "beforeTool:c1",
      "afterTool:c1",
      "onTurnEnd@1",
      "beforeModel@2",
      "afterModel:tool_call",
      "beforeTool:c2",
      "afterTool:c2",
      "onTurnEnd@2",
      "beforeModel@3",
      "afterModel:model_text",
      "onTurnEnd@3",
    ])
    // 注入的 system_note 排在用户消息之后、模型第一轮之前，且第一轮就看到了
    const logged = await all(log)
    expect(types(logged).slice(0, 3)).toEqual(["user_message", "system_note", "model_thinking"])
    expect(types(lowering.requests[0]?.events ?? [])).toEqual(["user_message", "system_note"])
  })

  it("beforeModel 可替换投影、工具与系统提示", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [say("好")] }])
    const other: Tool = { name: "noop", description: "", inputSchema: {}, execute: () => "" }
    const socket: Socket = {
      beforeModel: (ctx) => ({ events: ctx.events.slice(-1), tools: [other], systemPrompt: "改过的提示" }),
    }
    await drain(
      runLoop(
        baseConfig(lowering, log, {
          input: "问",
          sockets: [{ beforeModel: () => ({ systemPrompt: "会被覆盖" }) }, socket],
          systemPrompt: "原提示",
        }),
      ),
    )
    const req = lowering.requests[0]
    expect(req?.systemPrompt).toBe("改过的提示")
    expect(req?.tools?.map((t) => t.name)).toEqual(["noop"])
    expect(req?.events).toHaveLength(1)
  })

  it("beforeModel 补丁顺序合并：后一个 Socket 在 ctx 里看到前一个改过的工具表与视图", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [say("好")] }])
    const extra: Tool = { name: "extra", description: "", inputSchema: {}, execute: () => "" }
    const seen: string[][] = []
    await drain(
      runLoop(
        baseConfig(lowering, log, {
          input: "问",
          sockets: [
            { beforeModel: (ctx) => ({ tools: [...ctx.tools, extra], events: ctx.events.slice(-1) }) },
            {
              beforeModel: (ctx) => {
                seen.push(ctx.tools.map((t) => t.name))
                expect(ctx.events).toHaveLength(1)
                return { tools: [...ctx.tools, { ...extra, name: "third" }] }
              },
            },
          ],
        }),
      ),
    )
    expect(seen).toEqual([["add", "extra"]])
    expect(lowering.requests[0]?.tools?.map((t) => t.name)).toEqual(["add", "extra", "third"])
  })

  it("Socket 静态贡献：tools 并入工具表、systemPrompt 追加在宿主提示之后，每轮逐字相同；同名以宿主为准", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "brain_tool", { x: 1 })] },
      { drafts: [say("好")] },
    ])
    const brainTool: Tool = {
      name: "brain_tool",
      description: "脑子的工具",
      inputSchema: {},
      execute: () => "脑子答",
    }
    const shadowed: Tool = {
      name: "add",
      description: "模块想覆盖 add",
      inputSchema: {},
      execute: () => "不该跑",
    }
    const socket: Socket = { name: "m", tools: [brainTool, shadowed], systemPrompt: "模块规则" }
    const { result } = await drain(
      runLoop(
        baseConfig(lowering, log, {
          input: "问",
          systemPrompt: "宿主提示",
          sockets: [{ systemPrompt: "   " }, socket],
        }),
      ),
    )
    expect(result.status).toBe("done")
    for (const req of lowering.requests) {
      expect(req.systemPrompt).toBe("宿主提示\n\n模块规则")
      expect(req.tools?.map((t) => [t.name, t.description])).toEqual([
        ["add", "两数相加"],
        ["brain_tool", "脑子的工具"],
      ])
    }
    const res = (await all(log)).find((e) => e.type === "core.tool_result") as CoreEventOf<"core.tool_result">
    expect(res.payload.content).toEqual([{ type: "text", text: "脑子答" }])
  })

  it("Socket 静态工具在续跑补齐 pending 调用时也在场（beforeModel 补丁做不到这点）", async () => {
    const log = new InMemoryEventLog()
    // 模拟上一进程在 tool_call 之后、tool_result 之前死掉
    await log.append([
      createCoreEvent(registry, {
        type: "core.user_message",
        actor: "user",
        sessionId: SESSION,
        seq: 1,
        payload: { content: [{ type: "text", text: "问" }] },
      }),
      createCoreEvent(registry, {
        type: "core.tool_call",
        actor: "model",
        sessionId: SESSION,
        seq: 2,
        payload: { toolCallId: "c1", name: "brain_tool", args: {} },
      }),
    ])
    const brainTool: Tool = { name: "brain_tool", description: "", inputSchema: {}, execute: () => "补齐了" }
    const lowering = new ScriptedLowering([{ drafts: [say("好")] }])
    await drain(runLoop(baseConfig(lowering, log, { sockets: [{ tools: [brainTool] }] })))
    const res = (await all(log)).find((e) => e.type === "core.tool_result") as CoreEventOf<"core.tool_result">
    expect(res.payload.isError).toBe(false)
    expect(res.payload.content).toEqual([{ type: "text", text: "补齐了" }])
  })

  it("beforeTool block：结果为 isError 并说明原因，模型下一轮看得到", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "add", { a: 1, b: 1 })] },
      { drafts: [say("好")] },
    ])
    const { result } = await drain(
      runLoop(
        baseConfig(lowering, log, { input: "算", sockets: [{ beforeTool: () => ({ block: "只读模式" }) }] }),
      ),
    )
    expect(result.status).toBe("done")
    const res = (await all(log)).find((e) => e.type === "core.tool_result") as CoreEventOf<"core.tool_result">
    expect(res.payload.isError).toBe(true)
    expect(res.payload.content[0]).toEqual({ type: "text", text: "工具调用被拦截：只读模式" })
    expect(lowering.requests[1]?.events.map((e) => e.type)).toContain("core.tool_result")
  })

  it("beforeTool rewrite：用改写后的入参执行；afterTool 可替换结果", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "add", { a: 1, b: 1 })] },
      { drafts: [say("好")] },
    ])
    const sockets: Socket[] = [
      { beforeTool: () => ({ rewrite: { a: 10, b: 10 } }) },
      {
        afterTool: (_ctx, _call, result) => ({
          ...result,
          payload: {
            ...result.payload,
            content: [
              {
                type: "text",
                text: `[已外溢] ${result.payload.content[0]?.type === "text" ? result.payload.content[0].text : ""}`,
              },
            ],
          },
        }),
      },
    ]
    await drain(runLoop(baseConfig(lowering, log, { input: "算", sockets })))
    const res = (await all(log)).find((e) => e.type === "core.tool_result") as CoreEventOf<"core.tool_result">
    expect(res.payload.content).toEqual([{ type: "text", text: "[已外溢] 20" }])
  })

  it("onTurnEnd continue 强行再来一轮；stop 在有工具调用时也能结束", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [say("先说一句")] },
      { drafts: [callTool("c1", "add", { a: 1, b: 2 })] },
    ])
    let turn = 0
    const socket: Socket = {
      onTurnEnd() {
        turn++
        // 第一轮模型只说话本应结束，强行继续；第二轮有工具调用本应继续，强行停止
        return turn === 1 ? "continue" : "stop"
      },
    }
    const { result } = await drain(runLoop(baseConfig(lowering, log, { input: "问", sockets: [socket] })))
    expect(result.status).toBe("done")
    expect(lowering.requests).toHaveLength(2)
    // 工具仍然执行了，结果在日志里
    expect(types(await all(log))).toContain("tool_result")
  })

  it("onTurnEnd pause：run_paused 入日志，返回 paused(budget)", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [say("好")] }])
    const { result } = await drain(
      runLoop(
        baseConfig(lowering, log, {
          input: "问",
          sockets: [{ onTurnEnd: () => ({ pause: { reason: "budget", note: "token 触顶" } }) }],
        }),
      ),
    )
    expect(result.status).toBe("paused")
    if (result.status !== "paused") return
    expect(result.reason).toBe("budget")
    expect(result.interruptions).toEqual([{ kind: "budget", note: "token 触顶" }])
    expect(result.state).toMatchObject({
      v: 1,
      sessionId: SESSION,
      lastSeq: result.lastSeq,
      pendingToolCallIds: [],
    })
    expect(result.state.configHash).toMatch(/^[0-9a-f]{64}$/)
    expect(types(await all(log)).at(-1)).toBe("run_paused")
  })
})

describe("runLoop：审批暂停与续跑", () => {
  const deployTool: Tool = {
    name: "deploy",
    description: "上线",
    inputSchema: { type: "object" },
    needsApproval: true,
    execute: () => "已上线",
  }

  it("defer → approval_request + run_paused，返回可序列化状态；工具没有执行", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [callTool("c1", "add", { a: 1, b: 1 })] }])
    const { result } = await drain(
      runLoop(
        baseConfig(lowering, log, {
          input: "算",
          sockets: [{ beforeTool: () => ({ defer: { policyId: "ask-math", summary: "要算数了" } }) }],
        }),
      ),
    )
    expect(result.status).toBe("paused")
    if (result.status !== "paused") return
    expect(result.reason).toBe("approval")
    expect(result.interruptions).toEqual([
      {
        kind: "approval",
        toolCallId: "c1",
        request: { toolCallId: "c1", policyId: "ask-math", summary: "要算数了" },
        call: { toolCallId: "c1", name: "add", args: { a: 1, b: 1 } },
      },
    ])
    expect(result.state.pendingToolCallIds).toEqual(["c1"])
    expect(types(await all(log))).toEqual([
      "user_message",
      "tool_call",
      "approval_request",
      "budget_usage",
      "run_paused",
    ])
    expect(JSON.parse(JSON.stringify(result.state))).toEqual(result.state)
  })

  it("没有 Socket 做主时，needsApproval 的工具直接转审批（安全默认）", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [callTool("c1", "deploy", { env: "prod" })] }])
    const { result } = await drain(runLoop(baseConfig(lowering, log, { input: "上线", tools: [deployTool] })))
    expect(result.status).toBe("paused")
    if (result.status !== "paused") return
    const first = result.interruptions[0]
    expect(first?.kind === "approval" && first.request.policyId).toBe(BUILTIN_APPROVAL_POLICY)
  })

  it("再跑一次没有决定：不重复发 approval_request，再次暂停；有决定后执行并结束", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "deploy", { env: "prod" })] },
      { drafts: [say("上线完成")] },
    ])
    const cfg = baseConfig(lowering, log, { tools: [deployTool] })

    const first = await drain(runLoop({ ...cfg, input: "上线" }))
    expect(first.result.status).toBe("paused")

    // 进程 B：同一 sessionId 续跑，没人批 → 还是暂停，日志里只多一条 run_paused
    const second = await drain(runLoop(cfg))
    expect(second.result.status).toBe("paused")
    const afterSecond = types(await all(log))
    expect(afterSecond.filter((t) => t === "approval_request")).toHaveLength(1)
    expect(afterSecond.at(-1)).toBe("run_paused")

    // 宿主写入批准（T10 会把这一步封装成 decisions 参数）
    const tailSeq = (await log.tail(SESSION, 1))[0]?.seq ?? 0
    await log.append([
      createCoreEvent(registry, {
        type: "core.approval_decision",
        actor: "host",
        sessionId: SESSION,
        seq: tailSeq + 1,
        payload: { toolCallId: "c1", approved: true, by: "boss" },
      }),
    ])
    const third = await drain(runLoop(cfg))
    expect(third.result.status).toBe("done")
    const logged = await all(log)
    const res = logged.find((e) => e.type === "core.tool_result") as CoreEventOf<"core.tool_result">
    expect(res.payload).toMatchObject({
      toolCallId: "c1",
      isError: false,
      content: [{ type: "text", text: "已上线" }],
    })
    // 模型第二轮看到了工具结果，审批与暂停事件对它不可见
    expect(types(lowering.requests[1]?.events ?? [])).toEqual(["user_message", "tool_call", "tool_result"])
  })

  it("审批被拒绝：结果为 isError，模型据此继续", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "deploy", { env: "prod" })] },
      { drafts: [say("那就不上了")] },
    ])
    const cfg = baseConfig(lowering, log, { tools: [deployTool] })
    await drain(runLoop({ ...cfg, input: "上线" }))
    const tailSeq = (await log.tail(SESSION, 1))[0]?.seq ?? 0
    await log.append([
      createCoreEvent(registry, {
        type: "core.approval_decision",
        actor: "host",
        sessionId: SESSION,
        seq: tailSeq + 1,
        payload: { toolCallId: "c1", approved: false, by: "boss", reason: "周五不上线" },
      }),
    ])
    const { result } = await drain(runLoop(cfg))
    expect(result.status).toBe("done")
    const res = (await all(log)).find((e) => e.type === "core.tool_result") as CoreEventOf<"core.tool_result">
    expect(res.payload.isError).toBe(true)
    expect(res.payload.content).toEqual([{ type: "text", text: "审批被拒绝：周五不上线" }])
  })

  it("并行调用中一个要审批、一个不用：不用的先执行，整体暂停", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "add", { a: 1, b: 1 }), callTool("c2", "deploy", {})] },
    ])
    const { result } = await drain(
      runLoop(baseConfig(lowering, log, { input: "算并上线", tools: [addTool, deployTool] })),
    )
    expect(result.status).toBe("paused")
    if (result.status !== "paused") return
    expect(result.state.pendingToolCallIds).toEqual(["c2"])
    expect(types(await all(log))).toEqual([
      "user_message",
      "tool_call",
      "tool_call",
      "tool_result",
      "approval_request",
      "budget_usage",
      "run_paused",
    ])
  })
})

describe("runLoop：工具的各种失败与客户端工具", () => {
  it("未知工具、执行抛错、入参不合法都以 isError 结果告知模型，循环不崩", async () => {
    const boom: Tool = {
      name: "boom",
      description: "",
      inputSchema: {},
      execute: () => {
        throw new Error("炸了")
      },
    }
    const strict = defineTool<{ n: number }>({
      name: "strict",
      description: "",
      inputSchema: {},
      validate: (input) => {
        const n = (input as { n?: unknown }).n
        if (typeof n !== "number") throw new Error("n 必须是数字")
        return { n }
      },
      execute: ({ n }) => n * 2,
    })
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      {
        drafts: [
          callTool("c1", "nope", {}),
          callTool("c2", "boom", {}),
          callTool("c3", "strict", { n: "x" }),
          callTool("c4", "strict", { n: 21 }),
        ],
      },
      { drafts: [say("完")] },
    ])
    const { result } = await drain(runLoop(baseConfig(lowering, log, { input: "试", tools: [boom, strict] })))
    expect(result.status).toBe("done")
    const results = (await all(log)).filter(
      (e): e is CoreEventOf<"core.tool_result"> => e.type === "core.tool_result",
    )
    expect(results.map((r) => [r.payload.isError, (r.payload.content[0] as { text: string }).text])).toEqual([
      [true, "未知工具：nope"],
      [true, "工具执行失败：炸了"],
      [true, "入参不合法：n 必须是数字"],
      [false, "42"],
    ])
  })

  it("execute 返回值归一：对象转 JSON、{content,isError} 原样、undefined 给空文本", async () => {
    const tools: Tool[] = [
      { name: "obj", description: "", inputSchema: {}, execute: () => ({ ok: true }) },
      {
        name: "err",
        description: "",
        inputSchema: {},
        execute: () => ({ content: [{ type: "text", text: "不行" }], isError: true }),
      },
      { name: "void", description: "", inputSchema: {}, execute: () => undefined },
    ]
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "obj", {}), callTool("c2", "err", {}), callTool("c3", "void", {})] },
      { drafts: [say("完")] },
    ])
    await drain(runLoop(baseConfig(lowering, log, { input: "试", tools })))
    const results = (await all(log)).filter(
      (e): e is CoreEventOf<"core.tool_result"> => e.type === "core.tool_result",
    )
    expect(results.map((r) => r.payload)).toEqual([
      { toolCallId: "c1", name: "obj", content: [{ type: "text", text: '{"ok":true}' }], isError: false },
      { toolCallId: "c2", name: "err", content: [{ type: "text", text: "不行" }], isError: true },
      { toolCallId: "c3", name: "void", content: [{ type: "text", text: "" }], isError: false },
    ])
  })

  it("客户端工具：暂停等宿主回填结果，回填后续跑", async () => {
    const pick: Tool = { name: "pick_file", description: "让用户选文件", inputSchema: {}, side: "client" }
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "pick_file", {})] },
      { drafts: [say("收到")] },
    ])
    const cfg = baseConfig(lowering, log, { tools: [pick] })
    const first = await drain(runLoop({ ...cfg, input: "选" }))
    expect(first.result.status).toBe("paused")
    if (first.result.status !== "paused") return
    expect(first.result.reason).toBe("host")
    expect(first.result.interruptions).toEqual([
      { kind: "client_tool", toolCallId: "c1", call: { toolCallId: "c1", name: "pick_file", args: {} } },
    ])

    const tailSeq = (await log.tail(SESSION, 1))[0]?.seq ?? 0
    await log.append([
      createCoreEvent(registry, {
        type: "core.tool_result",
        actor: "tool",
        sessionId: SESSION,
        seq: tailSeq + 1,
        payload: {
          toolCallId: "c1",
          name: "pick_file",
          content: [{ type: "text", text: "a.txt" }],
          isError: false,
        },
      }),
    ])
    const second = await drain(runLoop(cfg))
    expect(second.result.status).toBe("done")
    expect(types(lowering.requests[1]?.events ?? [])).toEqual(["user_message", "tool_call", "tool_result"])
  })

  it("工具经 ctx.emit 留痕：痕在结果之前入日志", async () => {
    const remember: Tool = {
      name: "remember",
      description: "",
      inputSchema: {},
      execute: (_input, ctx) => {
        ctx.emit({
          type: "core.memory_op",
          actor: "model",
          payload: { op: "create", path: "/memories/a", bytes: 3 },
        })
        return "ok"
      },
    }
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "remember", {})] },
      { drafts: [say("完")] },
    ])
    await drain(runLoop(baseConfig(lowering, log, { input: "记", tools: [remember] })))
    expect(types(await all(log)).slice(1, 4)).toEqual(["tool_call", "memory_op", "tool_result"])
  })
})

describe("runLoop：错误、中止、上限、交接", () => {
  it("降级层返回 error：记 core.error，返回 error 态", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [say("说了一半")], outcome: { stopReason: "error", errorMessage: "529 overloaded" } },
    ])
    const { result } = await drain(runLoop(baseConfig(lowering, log, { input: "问" })))
    expect(result.status).toBe("error")
    if (result.status !== "error") return
    expect(result.error.payload).toMatchObject({ category: "provider", message: "529 overloaded" })
    // 说了一半的内容仍在日志里 —— 记录发生过什么
    expect(types(await all(log))).toEqual(["user_message", "model_text", "error"])
  })

  it("降级层抛异常（缺 key、断网）：同样记 error 事件而不是让生成器炸掉", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [], throws: new Error("ECONNRESET") }])
    const { result } = await drain(runLoop(baseConfig(lowering, log, { input: "问" })))
    expect(result.status).toBe("error")
    if (result.status !== "error") return
    expect(result.error.payload).toMatchObject({ category: "lowering", message: "ECONNRESET" })
  })

  it("宿主中止：模型响应 aborted 后以 paused(host) 返回，未回答的 tool_call 记为 pending", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "add", { a: 1, b: 1 })], outcome: { stopReason: "aborted" } },
    ])
    const { result } = await drain(runLoop(baseConfig(lowering, log, { input: "算" })))
    expect(result.status).toBe("paused")
    if (result.status !== "paused") return
    expect(result.reason).toBe("host")
    expect(result.state.pendingToolCallIds).toEqual(["c1"])
    // 工具没执行
    expect(types(await all(log))).toEqual(["user_message", "tool_call", "run_paused"])
  })

  it("signal 在开轮前已中止：直接 paused(host)，不调模型", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [say("不该看到")] }])
    const ac = new AbortController()
    ac.abort()
    const { result } = await drain(runLoop(baseConfig(lowering, log, { input: "问", signal: ac.signal })))
    expect(result.status).toBe("paused")
    expect(lowering.requests).toHaveLength(0)
  })

  it("maxTurns 兜底：达到上限以 paused(budget) 返回", async () => {
    const log = new InMemoryEventLog()
    // 模型永远想再调一次工具
    const lowering = new ScriptedLowering((_input, turn) => ({
      drafts: [callTool(`c${turn}`, "add", { a: 1, b: 1 })],
    }))
    const { result } = await drain(runLoop(baseConfig(lowering, log, { input: "无限", maxTurns: 3 })))
    expect(result.status).toBe("paused")
    if (result.status !== "paused") return
    expect(result.reason).toBe("budget")
    expect(lowering.requests).toHaveLength(3)
  })

  it("handoff：旧会话记 handoff，新会话开头带摘要与触发消息，宿主回调被调用", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [say("任务太长，我交接一下")] }])
    const handoffs: [string, string][] = []
    const socket: Socket = {
      onTurnEnd: () => ({
        handoff: { summary: "已完成 A、B，剩 C", triggerMessage: "继续做 C", reason: "context_pressure" },
      }),
    }
    const { events, result } = await drain(
      runLoop(
        baseConfig(lowering, log, {
          input: "做 ABC",
          sockets: [socket],
          onHandoff: (a, b) => void handoffs.push([a, b]),
        }),
      ),
    )
    expect(result.status).toBe("handoff")
    if (result.status !== "handoff") return
    expect(handoffs).toEqual([[SESSION, result.toSessionId]])

    const old = await all(log)
    expect(types(old)).toEqual(["user_message", "model_text", "budget_usage", "handoff"])
    const handoff = old.at(-1) as CoreEventOf<"core.handoff">
    expect(handoff.actor).toBe("model")
    expect(handoff.payload).toEqual({
      toSessionId: result.toSessionId,
      summary: "已完成 A、B，剩 C",
      triggerMessage: "继续做 C",
      reason: "context_pressure",
    })

    const fresh = await all(log, result.toSessionId)
    expect(fresh.map((e) => [e.seq, e.type])).toEqual([
      [1, "core.system_note"],
      [2, "core.user_message"],
    ])
    expect((fresh[0] as CoreEventOf<"core.system_note">).payload).toEqual({
      kind: "host",
      text: "已完成 A、B，剩 C",
    })
    // 新会话的两条也 yield 给了宿主
    expect(events.filter((e) => e.sessionId === result.toSessionId)).toHaveLength(2)
  })

  it("投影新造的阈值 compaction 先入日志再问模型", async () => {
    const log = new InMemoryEventLog()
    // 先灌一段长历史
    const filler = "很长的历史。".repeat(50)
    const history = [
      ["core.user_message", "user", { content: [{ type: "text", text: filler }] }],
      ["core.model_text", "model", { text: filler }],
      ["core.user_message", "user", { content: [{ type: "text", text: filler }] }],
      ["core.model_text", "model", { text: filler }],
    ] as const
    await log.append(
      history.map(([type, actor, payload], i) =>
        createCoreEvent(registry, { type, actor, sessionId: SESSION, seq: i + 1, payload } as never),
      ),
    )
    const lowering = new ScriptedLowering([{ drafts: [say("好")] }], { capabilities: { contextWindow: 800 } })
    const { result } = await drain(runLoop(baseConfig(lowering, log, { input: "短问题" })))
    expect(result.status).toBe("done")
    const logged = await all(log)
    const compaction = logged.find((e) => e.type === "core.compaction") as CoreEventOf<"core.compaction">
    expect(compaction).toBeDefined()
    expect(compaction.payload.decidedBy).toBe("threshold")
    // 模型看到的第一条就是这条摘要
    expect(lowering.requests[0]?.events[0]?.id).toBe(compaction.id)
  })
})
