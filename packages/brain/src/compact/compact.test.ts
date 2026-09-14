import {
  type CoreEvent,
  type CoreEventOf,
  createCoreEvent,
  createCoreRegistry,
  defineTool,
  type Event,
  InMemoryEventLog,
  type LoopConfig,
  type RunResult,
  runLoop,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, type ScriptedTurn, say, think } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { perception } from "../perception/index.js"
import { pins } from "../pins/index.js"
import { compact, isModelCompaction } from "./compact.js"
import {
  MANIFEST_HEADING,
  parseCompactArgs,
  planCompaction,
  renderCompactionSummary,
  segmentTimelineByTurn,
  trailingCompactionRun,
} from "./plan.js"
import { parseRecallArgs, recallResult } from "./recall.js"
import { COMPACT_RULES } from "./rules.js"

const registry = createCoreRegistry()
const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"
type Compaction = CoreEventOf<"core.compaction">
type ToolResult = CoreEventOf<"core.tool_result">

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
const compactionsOf = (events: readonly Event[]) =>
  events.filter((e): e is Compaction => e.type === "core.compaction")
const resultOf = (events: readonly CoreEvent[], toolCallId: string) =>
  events.find(
    (e): e is ToolResult => e.type === "core.tool_result" && e.payload.toolCallId === toolCallId,
  ) as ToolResult

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
    tools: [addTool],
    systemPrompt: "你是计算器",
    input: "2+3 再加 4 等于几？",
    sockets: [compact()],
    ...deterministic(),
    ...extra,
  }
}

const doCompact = (id: string, args: Record<string, unknown>) => callTool(id, "compact", args)

describe("compact × runLoop：模型自决整理", () => {
  it("工具与规则提示是静态贡献：每轮工具表与系统提示逐字相同，规则接在宿主提示之后", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "add", { a: 2, b: 3 })] },
      { drafts: [say("5")] },
    ])
    await drain(runLoop(config(lowering, log)))
    expect(lowering.requests).toHaveLength(2)
    for (const req of lowering.requests) {
      expect(req.systemPrompt).toBe(`你是计算器\n\n${COMPACT_RULES}`)
      expect(req.tools?.map((t) => t.name)).toEqual(["add", "compact", "recall"])
    }
    const spec = lowering.requests[0]?.tools?.find((t) => t.name === "compact")
    expect(spec?.inputSchema).toMatchObject({ required: ["summary", "keep"] })
  })

  it("keepRecentTurns 缺省 0：折叠本轮之前可见的一切；日志顺序 tool_call → compaction → 回执；下一轮只见摘要与本轮", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [think("先算 2+3"), callTool("c1", "add", { a: 2, b: 3 })] },
      {
        drafts: [
          think("子任务完成，整理一下"),
          doCompact("c2", { summary: "User asked 2+3+4. Computed 2+3=5.", keep: ["intermediate result: 5"] }),
        ],
      },
      { drafts: [callTool("c3", "add", { a: 5, b: 4 })] },
      { drafts: [say("答案是 9")] },
    ])
    const { result } = await drain(runLoop(config(lowering, log)))
    expect(result.status).toBe("done")

    const logged = await all(log)
    // 起步的 tools_bound 占 seq 1，其后整体后移一位
    // 第 2 轮：thinking(7) tool_call(8) compaction(9) tool_result(10) budget_usage(11)
    expect(types(logged).slice(6, 11)).toEqual([
      "model_thinking",
      "tool_call",
      "compaction",
      "tool_result",
      "budget_usage",
    ])
    const c = compactionsOf(logged)[0] as Compaction
    const call = logged[7] as CoreEventOf<"core.tool_call">
    expect(c.actor).toBe("model")
    expect(c.trust).toBe("model")
    expect(c.parentId).toBe(call.id)
    expect(c.provenance).toEqual({ source: "compact", ref: "c2" })
    expect(c.payload).toEqual({
      // 第 2 轮开始时可见的是 seq 2–5（user、thinking、tool_call、tool_result；
      // tools_bound 1 与 budget_usage 6 对模型不可见）
      coversSeq: [2, 5],
      // 要点清单之后是被折叠工具结果清单（E3c）：结果 "5" 只有 1 个字符
      summary:
        "User asked 2+3+4. Computed 2+3=5.\n\nKey facts carried forward:\n- intermediate result: 5\n\n" +
        `${MANIFEST_HEADING}\n- seq 5 add({"a":2,"b":3}) — 1 chars`,
      decidedBy: "model",
      // 最近一条用户消息缺省幸存（见 plan.ts 第 4 条）；它现在是 logged[1]，logged[0] 是 tools_bound
      pinsKept: [logged[1]?.id],
    })
    expect(isModelCompaction(c)).toBe(true)

    const receipt = resultOf(logged, "c2")
    expect(receipt.payload.isError).toBe(false)
    expect(receipt.payload.content[0]).toEqual({
      type: "text",
      text:
        "Folded 4 events (seq 2–5) into your summary. " +
        "1 folded tool result(s) are listed under the summary and can be brought back verbatim with recall({ seq }). " +
        "1 item(s) carried over verbatim (pinned notes and the latest user message). " +
        "Only the current turn stays unfolded. The originals remain in the session log.",
    })

    // 第 3 轮模型看到的：摘要 → 幸存的用户消息 → 第 2 轮自己的 thinking + tool_call + 回执；被折叠的 add 调用不在
    const third = lowering.requests[2]
    expect(types(third?.events ?? [])).toEqual([
      "compaction",
      "user_message",
      "model_thinking",
      "tool_call",
      "tool_result",
    ])
    expect(third?.events[0]?.id).toBe(c.id)
    expect(third?.events[1]?.seq).toBe(2)
    // 第 4 轮继续在摘要之后累加，摘要位置不变（前缀稳定）
    const fourth = lowering.requests[3]
    expect(types(fourth?.events ?? [])).toEqual([
      "compaction",
      "user_message",
      "model_thinking",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
    ])
  })

  it("keepRecentTurns = 1：最后一个模型轮连同它的工具结果留在视图里", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [think("先算 2+3"), callTool("c1", "add", { a: 2, b: 3 })] },
      { drafts: [callTool("c2", "add", { a: 5, b: 4 })] },
      { drafts: [doCompact("c3", { summary: "Early steps folded.", keep: [], keepRecentTurns: 1 })] },
      { drafts: [say("9")] },
    ])
    await drain(runLoop(config(lowering, log)))
    const logged = await all(log)
    const c = compactionsOf(logged)[0] as Compaction
    // tools_bound 占 seq 1；第 3 轮开始时可见：user(2) thinking(3) call(4) result(5) | call(7) result(8)
    // 保留最后一个模型轮 → 折 2–5
    expect(c.payload.coversSeq).toEqual([2, 5])
    expect(c.payload.summary).toBe(
      `Early steps folded.\n\n${MANIFEST_HEADING}\n- seq 5 add({"a":2,"b":3}) — 1 chars`,
    )
    expect(resultOf(logged, "c3").payload.content[0]).toMatchObject({
      text: expect.stringContaining("The last 1 model turn(s) stay unfolded."),
    })
    expect(resultOf(logged, "c3").payload.content[0]).toMatchObject({
      text: expect.stringContaining(
        "1 folded tool result(s) are listed under the summary and can be brought back verbatim with recall({ seq })",
      ),
    })
    expect(types(lowering.requests[3]?.events ?? [])).toEqual([
      "compaction",
      "user_message",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
    ])
    const keptCall = lowering.requests[3]?.events[2] as CoreEventOf<"core.tool_call"> | undefined
    expect(keptCall?.payload.toolCallId).toBe("c2")
  })

  it("入参不合法 / 没东西可折：以 isError 告知模型，不写 compaction", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [doCompact("bad1", { summary: "", keep: [] })] },
      { drafts: [doCompact("bad2", { summary: "x", keep: "not-an-array" })] },
      { drafts: [doCompact("bad3", { summary: "x", keep: [], keepRecentTurns: -1 })] },
      { drafts: [doCompact("none", { summary: "x", keep: [], keepRecentTurns: 5 })] },
      { drafts: [say("好")] },
    ])
    const { result } = await drain(runLoop(config(lowering, log)))
    expect(result.status).toBe("done")
    const logged = await all(log)
    expect(compactionsOf(logged)).toHaveLength(0)
    for (const id of ["bad1", "bad2", "bad3", "none"]) expect(resultOf(logged, id).payload.isError).toBe(true)
    expect(resultOf(logged, "bad1").payload.content[0]).toMatchObject({
      text: expect.stringContaining("`summary`"),
    })
    expect(resultOf(logged, "none").payload.content[0]).toMatchObject({
      text: "Nothing to fold: only 3 model turn(s) are visible before this one, and you asked to keep 5.",
    })
  })

  it("再次整理（keepRecentTurns 0）吸收旧摘要：区间从旧摘要的起点算起，视图里只剩新摘要", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "add", { a: 2, b: 3 })] },
      { drafts: [doCompact("c2", { summary: "First summary.", keep: [] })] },
      { drafts: [callTool("c3", "add", { a: 5, b: 4 })] },
      { drafts: [doCompact("c4", { summary: "Second summary, includes the first.", keep: [] })] },
      { drafts: [say("9")] },
    ])
    await drain(runLoop(config(lowering, log)))
    const logged = await all(log)
    const [first, second] = compactionsOf(logged) as [Compaction, Compaction]
    // tools_bound 占 seq 1，其后整体后移一位
    expect(first.payload.coversSeq).toEqual([2, 4])
    // 第 4 轮开始时可见：first(7)、call c2(6)、result(8)、call c3(10)、result(11)；全部折叠，旧摘要一起吸收
    expect(second.payload.coversSeq).toEqual([2, 11])
    expect(second.seq).toBeGreaterThan(11)
    expect(resultOf(logged, "c4").payload.content[0]).toMatchObject({
      text: expect.stringContaining("1 earlier summary(ies) were absorbed."),
    })
    const last = lowering.requests[4]
    expect(compactionsOf(last?.events ?? []).map((c) => c.id)).toEqual([second.id])
    expect(types(last?.events ?? [])).toEqual(["compaction", "user_message", "tool_call", "tool_result"])
  })

  it("保留的轮比旧摘要更早时不吸收它（seq 封闭）：两条摘要按时间先后都可见", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [think("t"), callTool("c1", "add", { a: 1, b: 1 })] },
      { drafts: [callTool("c2", "add", { a: 2, b: 2 })] },
      { drafts: [doCompact("c3", { summary: "Old.", keep: [], keepRecentTurns: 1 })] },
      { drafts: [callTool("c4", "add", { a: 3, b: 3 })] },
      { drafts: [doCompact("c5", { summary: "New.", keep: [], keepRecentTurns: 2 })] },
      { drafts: [say("done")] },
    ])
    await drain(runLoop(config(lowering, log)))
    const logged = await all(log)
    const [old, fresh] = compactionsOf(logged) as [Compaction, Compaction]
    // tools_bound 占 seq 1，其后整体后移一位
    expect(old.payload.coversSeq).toEqual([2, 5])
    // 第 5 轮开始时视图：old(seq 11) user(2，old 保住的) | call c2(7) result(8) | call c3(10) result(12) | call c4(14) result(15)
    // 保留最后 2 个模型轮 → 折 user(2)、7–8；old 的 seq 11 不小于保留部分的最小 seq 10，留在视图里不吸收
    expect(fresh.payload.coversSeq).toEqual([2, 8])
    expect(fresh.payload.pinsKept).toEqual([logged[1]?.id])
    expect(resultOf(logged, "c5").payload.content[0]).toMatchObject({
      text: expect.not.stringContaining("absorbed"),
    })
    const view = lowering.requests[5]?.events ?? []
    expect(compactionsOf(view).map((c) => c.payload.summary.split("\n")[0])).toEqual(["Old.", "New."])
    expect(types(view)).toEqual([
      "compaction",
      "compaction",
      "user_message",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
    ])
  })

  it("被折叠范围内的 pin 说明记进 pinsKept，折叠后仍紧跟摘要可见", async () => {
    const log = new InMemoryEventLog()
    await log.append([
      createCoreEvent(registry, {
        type: "core.user_message",
        actor: "user",
        sessionId: SESSION,
        seq: 1,
        payload: { content: [{ type: "text", text: "只用公制单位" }] },
      }),
      createCoreEvent(registry, {
        type: "core.system_note",
        actor: "model",
        sessionId: SESSION,
        seq: 2,
        payload: { kind: "pin", text: "Constraint: metric units only." },
      }),
      createCoreEvent(registry, {
        type: "core.model_text",
        actor: "model",
        sessionId: SESSION,
        seq: 3,
        payload: { text: "好的" },
      }),
    ])
    const lowering = new ScriptedLowering([
      { drafts: [doCompact("c1", { summary: "Setup done.", keep: [] })] },
      { drafts: [say("继续")] },
    ])
    await drain(runLoop(config(lowering, log, { input: "开始吧" })))
    const logged = await all(log)
    const c = compactionsOf(logged)[0] as Compaction
    // 预置的三条占 seq 1–3，起步的 tools_bound 占 seq 4，本次 input 落在 seq 5
    expect(c.payload.coversSeq).toEqual([1, 5])
    // pin 说明（seq 2）与最近一条用户消息"开始吧"（seq 5，即 logged[4]）幸存；更早的用户消息（seq 1）折进摘要
    expect(c.payload.pinsKept).toEqual([logged[1]?.id, logged[4]?.id])
    expect(resultOf(logged, "c1").payload.content[0]).toMatchObject({
      text: expect.stringContaining("2 item(s) carried over verbatim"),
    })
    const view = lowering.requests[1]?.events ?? []
    expect(types(view)).toEqual(["compaction", "system_note", "user_message", "tool_call", "tool_result"])
    expect((view[1] as CoreEventOf<"core.system_note">).payload.kind).toBe("pin")
    expect(view[2]?.seq).toBe(5)
  })

  it("与 perception 同装：整理后感知说明被折叠，下一轮按新读数重新注入一条", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "add", { a: 2, b: 3 })] },
      { drafts: [doCompact("c2", { summary: "S.", keep: [] })] },
      { drafts: [say("5")] },
    ])
    await drain(runLoop(config(lowering, log, { sockets: [perception(), compact()] })))
    const notes = (await all(log)).filter(
      (e) =>
        e.type === "core.system_note" && (e as CoreEventOf<"core.system_note">).payload.kind === "perception",
    )
    // 第 1 轮注入一条；第 2 轮同档不注入；第 3 轮旧说明已被折叠 → 重新注入（整理次数 0 → 1，文字也变了）
    expect(notes).toHaveLength(2)
    expect(types(lowering.requests[2]?.events ?? [])).toEqual([
      "compaction",
      "user_message",
      "tool_call",
      "tool_result",
      "system_note",
    ])
  })
})

describe("compact：阈值兜底与连续上限", () => {
  /** 每条事件按 100 token 估算，窗口 1000 → 裁剪目标 850：视图超过 8 条就触发阈值兜底 */
  const tinyWindow = {
    projection: { estimate: () => 100 },
  }
  const filler = (n: number): ScriptedTurn[] =>
    Array.from({ length: n }, (_, i) => ({
      drafts: [say(`步骤 ${i}`), callTool(`c${i}`, "add", { a: i, b: 1 })],
    }))

  it("模型不整理、视图超过裁剪目标 → core 投影链兜底折叠并记 compaction(threshold)；收尾作答的轮达到上限也不拦", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([...filler(4), { drafts: [say("完")] }], {
      capabilities: { contextWindow: 1000 },
    })
    // 第 4 轮视图 10 条 → 兜底；第 5 轮视图又到 10 条 → 再兜底，此时已连续 2 次 = 上限，但模型本轮直接作答（无工具调用）→ done
    const { result } = await drain(
      runLoop(
        config(lowering, log, { ...tinyWindow, sockets: [compact({ maxConsecutive: 2 })], maxTurns: 10 }),
      ),
    )
    expect(result.status).toBe("done")
    const cs = compactionsOf(await all(log))
    expect(cs).toHaveLength(2)
    expect(cs.every((c) => c.payload.decidedBy === "threshold")).toBe(true)
    expect(cs.every((c) => !isModelCompaction(c))).toBe(true)
    // 兜底摘要是模型第 4、5 轮看到的第一条
    expect(lowering.requests[3]?.events[0]?.id).toBe(cs[0]?.id)
    expect(lowering.requests[4]?.events[0]?.id).toBe(cs[1]?.id)
  })

  it("连续阈值兜底达到上限 → paused(budget) 并说明原因；日志里正好是上限条 compaction", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering(filler(20), { capabilities: { contextWindow: 1000 } })
    const { result } = await drain(
      runLoop(
        config(lowering, log, { ...tinyWindow, sockets: [compact({ maxConsecutive: 2 })], maxTurns: 50 }),
      ),
    )
    expect(result.status).toBe("paused")
    if (result.status !== "paused") return
    expect(result.reason).toBe("budget")
    expect(result.interruptions).toEqual([
      { kind: "budget", note: expect.stringContaining("compacted 2 times in a row") },
    ])
    const logged = await all(log)
    expect(compactionsOf(logged)).toHaveLength(2)
    expect(types(logged).at(-1)).toBe("run_paused")
    // 恢复（同一 sessionId 再跑）仍受同一规则约束：宿主没改配置就会再次撞上限
  })

  it("模型连着整理达到上限 → 暂停；中间有一轮正常工作则计数归零", async () => {
    const compactTurn = (id: string) => ({
      drafts: [doCompact(id, { summary: `S${id}`, keep: [] }), callTool(`${id}-add`, "add", { a: 1, b: 1 })],
    })
    // 三连整理 → 第三轮末暂停
    {
      const log = new InMemoryEventLog()
      const lowering = new ScriptedLowering([
        compactTurn("a"),
        compactTurn("b"),
        compactTurn("c"),
        { drafts: [say("x")] },
      ])
      const { result } = await drain(runLoop(config(lowering, log)))
      expect(result.status).toBe("paused")
      if (result.status !== "paused") return
      expect(result.interruptions[0]).toMatchObject({
        kind: "budget",
        note: expect.stringContaining("3 times in a row"),
      })
      expect(compactionsOf(await all(log))).toHaveLength(3)
      expect(lowering.requests).toHaveLength(3)
    }
    // 整理、干活、整理、整理 → 不暂停（干活那轮把计数清零）
    {
      const log = new InMemoryEventLog()
      const lowering = new ScriptedLowering([
        compactTurn("a"),
        { drafts: [callTool("work", "add", { a: 1, b: 1 })] },
        compactTurn("b"),
        compactTurn("c"),
        { drafts: [say("x")] },
      ])
      const { result } = await drain(runLoop(config(lowering, log)))
      expect(result.status).toBe("done")
      expect(compactionsOf(await all(log))).toHaveLength(3)
    }
    // 注意：只调 compact 不调别的工具的一轮也是"有工具调用"的轮（循环会继续），同样计入连续次数
  })

  it("rules: false 不碰系统提示；自定义 rules 替换；maxConsecutive 非法在构造时拒绝", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [say("好")] }])
    await drain(runLoop(config(lowering, log, { sockets: [compact({ rules: false })] })))
    expect(lowering.requests[0]?.systemPrompt).toBe("你是计算器")

    const lowering2 = new ScriptedLowering([{ drafts: [say("好")] }])
    await drain(
      runLoop(config(lowering2, new InMemoryEventLog(), { sockets: [compact({ rules: "自家规则" })] })),
    )
    expect(lowering2.requests[0]?.systemPrompt).toBe("你是计算器\n\n自家规则")

    expect(() => compact({ maxConsecutive: 0 })).toThrow(RangeError)
    expect(() => compact({ maxConsecutive: 1.5 })).toThrow(RangeError)
  })

  it("续跑补齐 pending 的 compact 调用：工具在场且按当时的视图折叠", async () => {
    const log = new InMemoryEventLog()
    // 上一进程在 tool_call(compact) 之后死掉
    await log.append([
      createCoreEvent(registry, {
        type: "core.user_message",
        actor: "user",
        sessionId: SESSION,
        seq: 1,
        payload: { content: [{ type: "text", text: "问" }] },
      }),
      createCoreEvent(registry, {
        type: "core.model_text",
        actor: "model",
        sessionId: SESSION,
        seq: 2,
        payload: { text: "答" },
      }),
      createCoreEvent(registry, {
        type: "core.tool_call",
        actor: "model",
        sessionId: SESSION,
        seq: 3,
        payload: { toolCallId: "pending", name: "compact", args: { summary: "Resumed fold.", keep: [] } },
      }),
    ])
    const lowering = new ScriptedLowering([{ drafts: [say("好")] }])
    const cfg = config(lowering, log)
    delete cfg.input
    const { result } = await drain(runLoop(cfg))
    expect(result.status).toBe("done")
    const logged = await all(log)
    // 预置的三条占 seq 1–3，起步的 tools_bound 占 seq 4，补齐的 compaction / 回执排在其后
    expect(types(logged).slice(4, 6)).toEqual(["compaction", "tool_result"])
    const c = compactionsOf(logged)[0] as Compaction
    // pending 路径的视图含这次调用本身所在的模型轮（seq 2–3）：那一轮必须整个保留，否则回执 tool_result 成孤儿
    expect(c.payload.coversSeq).toEqual([1, 1])
    expect(c.payload.pinsKept).toEqual([logged[0]?.id])
    expect(resultOf(logged, "pending").payload.isError).toBe(false)
    expect(types(lowering.requests[0]?.events ?? [])).toEqual([
      "compaction",
      "user_message",
      "model_text",
      "tool_call",
      "tool_result",
    ])
  })
})

describe("compact × recall：被折叠的工具结果有路可回（E3c）", () => {
  const doRecall = (id: string, seq: number) => callTool(id, "recall", { seq })

  it("整理后 recall({ seq }) 逐字取回原结果并带说明头；seq 指向非结果事件或不存在时以 isError 说明", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [think("先算 2+3"), callTool("c1", "add", { a: 2, b: 3 })] },
      { drafts: [doCompact("c2", { summary: "Computed 2+3.", keep: [] })] },
      // tools_bound 占 seq 1：add 的回执落在 seq 5、thinking 落在 seq 3
      { drafts: [doRecall("r1", 5), doRecall("r2", 3), doRecall("r3", 999)] },
      { drafts: [say("5")] },
    ])
    const { result } = await drain(runLoop(config(lowering, log)))
    expect(result.status).toBe("done")
    const logged = await all(log)
    const r1 = resultOf(logged, "r1")
    expect(r1.payload.isError).toBe(false)
    expect(r1.payload.content).toEqual([
      {
        type: "text",
        text: '[Recalled tool result seq 5: add({"a":2,"b":3}). Original output follows verbatim.]',
      },
      { type: "text", text: "5" },
    ])
    const r2 = resultOf(logged, "r2")
    expect(r2.payload.isError).toBe(true)
    expect(r2.payload.content[0]).toMatchObject({
      text: expect.stringContaining("is a model_thinking event, not a tool result"),
    })
    const r3 = resultOf(logged, "r3")
    expect(r3.payload.isError).toBe(true)
    expect(r3.payload.content[0]).toMatchObject({ text: "No event with seq 999 in this session." })
    // 取回的内容在下一轮视图里，与普通工具结果一样
    const view = lowering.requests[3]?.events ?? []
    expect(
      view.some((e) => e.type === "core.tool_result" && (e as ToolResult).payload.toolCallId === "r1"),
    ).toBe(true)
  })

  it("已外溢的原件不复述预览而指向 blob；只读本会话；fork 出的会话保留 seq 所以照样能取", async () => {
    const log = new InMemoryEventLog()
    const spilledResult = createCoreEvent(registry, {
      type: "core.tool_result",
      actor: "tool",
      sessionId: SESSION,
      seq: 1,
      at: 1,
      id: "x1",
      payload: {
        toolCallId: "big",
        name: "list",
        content: [{ type: "text", text: "[preview]" }],
        isError: false,
        spilled: { blobId: "b-1", summary: "12k chars" },
      },
    })
    await log.append([spilledResult])
    const ctxOf = (sessionId: string) => ({ sessionId, toolCallId: "t", log, emit: () => {} })
    const spilled = await recallResult({ seq: 1 }, ctxOf(SESSION))
    expect(spilled.isError).toBe(true)
    expect(spilled.content[0]).toMatchObject({
      text: expect.stringContaining('stored verbatim as blob "b-1". Read it with fetch_blob({ id: "b-1" })'),
    })
    // 别的会话看不到
    expect(await recallResult({ seq: 1 }, ctxOf("other"))).toMatchObject({
      isError: true,
      content: [{ text: "No event with seq 1 in this session." }],
    })
    // fork：事件复制且 seq 不变（eval 探针正是这样跑的）
    await log.fork(SESSION, 1, "child")
    const viaChild = await recallResult({ seq: 1 }, ctxOf("child"))
    expect(viaChild.content[0]).toMatchObject({ text: expect.stringContaining('blob "b-1"') })
    expect(() => parseRecallArgs({ seq: 0 })).toThrow(RangeError)
    expect(() => parseRecallArgs({})).toThrow(RangeError)
    expect(parseRecallArgs({ seq: 3 })).toEqual({ seq: 3 })
  })

  it("recall: false 不给工具、回执不提取回；manifest: false 摘要不带清单", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "add", { a: 2, b: 3 })] },
      { drafts: [doCompact("c2", { summary: "Plain.", keep: [] })] },
      { drafts: [say("5")] },
    ])
    await drain(runLoop(config(lowering, log, { sockets: [compact({ recall: false, manifest: false })] })))
    expect(lowering.requests[0]?.tools?.map((t) => t.name)).toEqual(["add", "compact"])
    const logged = await all(log)
    expect((compactionsOf(logged)[0] as Compaction).payload.summary).toBe("Plain.")
    expect(resultOf(logged, "c2").payload.content[0]).toMatchObject({
      text: expect.not.stringContaining("folded tool result"),
    })
  })

  it("清单不列脑子自己的回执（compact / pin / recall），列宿主工具的结果", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "add", { a: 1, b: 1 }), callTool("p1", "pin", { text: "keep 2" })] },
      { drafts: [doCompact("c2", { summary: "First.", keep: [] })] },
      { drafts: [doRecall("r1", 5)] },
      { drafts: [doCompact("c3", { summary: "Second.", keep: [] })] },
      { drafts: [say("2")] },
    ])
    await drain(runLoop(config(lowering, log, { sockets: [pins(), compact()] })))
    const logged = await all(log)
    const [first, second] = compactionsOf(logged) as [Compaction, Compaction]
    // tools_bound 占 seq 1：add 的回执落在 seq 5
    expect(first.payload.summary).toBe(`First.\n\n${MANIFEST_HEADING}\n- seq 5 add({"a":1,"b":1}) — 1 chars`)
    // 第二次整理吸收第一次：范围内有 compact 回执、recall 结果，都不列；add 的原结果已在上次清单里、这次仍是被折叠的原件，照列
    expect(second.payload.summary).toBe(
      `Second.\n\n${MANIFEST_HEADING}\n- seq 5 add({"a":1,"b":1}) — 1 chars`,
    )
  })
})

describe("compact 纯函数层", () => {
  let seq = 0
  const ev = <T extends CoreEvent["type"]>(
    type: T,
    payload: CoreEventOf<T>["payload"],
    actor: Event["actor"],
  ) =>
    createCoreEvent(registry, {
      type,
      payload,
      actor,
      sessionId: SESSION,
      seq: ++seq,
      at: seq,
      id: `e${seq}`,
    } as Parameters<typeof createCoreEvent>[1]) as Event
  const text = (t: string) => ev("core.model_text", { text: t }, "model")
  const user = (t: string) => ev("core.user_message", { content: [{ type: "text", text: t }] }, "user")
  /** 两个模型轮之间必有非模型事件（工具结果 / 用量），否则按口径算同一轮 */
  const usage = () =>
    ev("core.budget_usage", { tokens: { input: 1, output: 1 }, toolCalls: 0, wallMs: 1 }, "system")
  const note = (kind: "perception" | "pin", actor: Event["actor"] = "system") =>
    ev("core.system_note", { kind, text: kind }, actor)
  const compaction = (covers: [number, number], decidedBy: "model" | "threshold", pinsKept: string[] = []) =>
    ev(
      "core.compaction",
      { coversSeq: covers, summary: "s", decidedBy, pinsKept },
      decidedBy === "model" ? "model" : "system",
    )

  it("parseCompactArgs：规范化与拒绝", () => {
    expect(parseCompactArgs({ summary: "  S ", keep: [" a ", ""], keepRecentTurns: 2 })).toEqual({
      summary: "S",
      keep: ["a"],
      keepRecentTurns: 2,
    })
    expect(parseCompactArgs({ summary: "S" })).toEqual({ summary: "S", keep: [], keepRecentTurns: 0 })
    expect(() => parseCompactArgs(null)).toThrow(RangeError)
    expect(() => parseCompactArgs({ summary: 1 })).toThrow(RangeError)
    expect(() => parseCompactArgs({ summary: "S", keep: [1] })).toThrow(RangeError)
    expect(() => parseCompactArgs({ summary: "S", keepRecentTurns: 1.5 })).toThrow(RangeError)
  })

  it("planCompaction：视图里只有旧摘要时无事可折；旧摘要在保留部分之前且 seq 更小时被吸收", () => {
    seq = 0
    const c = compaction([1, 5], "model", ["e2"])
    expect(planCompaction([c], { summary: "S", keep: [], keepRecentTurns: 0 })).toEqual({
      ok: false,
      reason: expect.stringContaining("already a summary"),
    })
    const pin = note("pin", "model") // e2
    const t1 = text("a") // e3
    const u = user("more") // e4
    const t2 = text("b") // e5
    const plan = planCompaction([c, pin, t1, u, t2], { summary: "S", keep: ["k"], keepRecentTurns: 1 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    // 保留最后一个模型轮 t2(e5)；c(e1) 的 seq 小于 5 → 吸收，from 取它的起点 1；
    // pin 由旧摘要的 pinsKept 与自身身份双重幸存；最近的用户消息 u(e4) 缺省幸存，关掉选项就不留
    expect(plan.payload).toEqual({
      coversSeq: [1, 4],
      summary: "S\n\nKey facts carried forward:\n- k",
      decidedBy: "model",
      pinsKept: ["e2", "e4"],
    })
    const noUser = planCompaction(
      [c, pin, t1, u, t2],
      { summary: "S", keep: [], keepRecentTurns: 1 },
      { keepLatestUserMessage: false },
    )
    expect(noUser.ok && noUser.payload.pinsKept).toEqual(["e2"])
    expect(plan.absorbed).toEqual([c])
    expect(plan.folded).toEqual([pin, t1, u])
  })

  it("planCompaction 清单：入参在时间线里找、幸存者不列、超过 maxItems 折成一行、manifest:false 不列", () => {
    seq = 0
    const call = (id: string, name: string, args: unknown) =>
      ev("core.tool_call", { toolCallId: id, name, args }, "model")
    const result = (id: string, name: string, t: string) =>
      ev(
        "core.tool_result",
        { toolCallId: id, name, content: [{ type: "text", text: t }], isError: false },
        "tool",
      )
    const events = [
      user("q"), // e1
      call("a", "get", { id: 2, adv: 1 }), // e2
      call("b", "get", { id: 1 }), // e3
      result("a", "get", "x".repeat(1500)), // e4
      result("b", "get", "short"), // e5
      call("c", "fetch_blob", { id: "b" }), // e6
      result("c", "fetch_blob", "slice"), // e7
      text("done"), // e8
      usage(), // e9
    ]
    const plan = planCompaction(events, { summary: "S", keep: [], keepRecentTurns: 0 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    // 键排序后的入参；fetch_blob 的切片不列；e1 幸存但它不是工具结果
    expect(plan.manifest.map((m) => [m.seq, m.name, m.chars])).toEqual([
      [4, "get", 1500],
      [5, "get", 5],
    ])
    expect(plan.payload.summary).toBe(
      `S\n\n${MANIFEST_HEADING}\n- seq 4 get({"adv":1,"id":2}) — 1.5k chars\n- seq 5 get({"id":1}) — 5 chars`,
    )
    const capped = planCompaction(
      events,
      { summary: "S", keep: [], keepRecentTurns: 0 },
      { manifest: { maxItems: 1 } },
    )
    expect(capped.ok && capped.payload.summary).toBe(
      `S\n\n${MANIFEST_HEADING}\n- seq 4 get({"adv":1,"id":2}) — 1.5k chars\n- …and 1 more (seq 5–5)`,
    )
    const off = planCompaction(events, { summary: "S", keep: ["k"], keepRecentTurns: 0 }, { manifest: false })
    expect(off.ok && off.payload.summary).toBe("S\n\nKey facts carried forward:\n- k")
    expect(off.ok && off.manifest).toEqual([])
    expect(renderCompactionSummary({ summary: "S", keep: [] })).toBe("S")
  })

  it("segmentTimelineByTurn / trailingCompactionRun：阈值 compaction 与系统说明归入其后那一轮", () => {
    seq = 0
    const timeline = [
      user("q"), // 1 开场
      text("t1"), // 2 轮 1
      compaction([1, 1], "model"), // 3 轮 1 内模型自决
      usage(), // 4
      compaction([1, 4], "threshold"), // 5 轮 2 开始时的兜底
      note("perception"), // 6 轮 2 的感知
      text("t2"), // 7 轮 2
      usage(), // 8
      text("t3"), // 9 轮 3（无整理）
      usage(), // 10
      compaction([1, 10], "threshold"), // 11 轮 4 兜底
      text("t4"), // 12
    ]
    const segments = segmentTimelineByTurn(timeline).map((s) => s.map((e) => e.seq))
    expect(segments).toEqual([[1], [2, 3, 4], [5, 6, 7, 8], [9, 10], [11, 12]])
    expect(trailingCompactionRun(timeline)).toBe(1)
    // 去掉轮 3 → 轮 1、2、4 连续，总数 3
    expect(trailingCompactionRun(timeline.filter((e) => e.seq !== 9 && e.seq !== 10))).toBe(3)
    expect(trailingCompactionRun([])).toBe(0)
    expect(trailingCompactionRun([user("q")])).toBe(0)
  })
})
