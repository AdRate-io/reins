import {
  type CoreEventPayloads,
  type CoreEventType,
  createCoreEvent,
  createCoreRegistry,
  type Event,
} from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import {
  cacheHitRateOf,
  countCompactions,
  countRepeatedToolCalls,
  finalTextOf,
  measureTimeline,
  measureViolations,
  splitModelTurns,
  sumTokens,
} from "./metrics.js"
import type { PlantedConstraint } from "./types.js"

const registry = createCoreRegistry()
let seq = 0
function mk<T extends CoreEventType>(type: T, actor: Event["actor"], payload: CoreEventPayloads[T]): Event {
  seq++
  return createCoreEvent(registry, { sessionId: "m", seq, at: 1_800_000_000_000 + seq, type, actor, payload })
}
const text = (s: string) => [{ type: "text" as const, text: s }]
const user = (s: string) => mk("core.user_message", "user", { content: text(s) })
const say = (s: string) => mk("core.model_text", "model", { text: s })
const call = (id: string, name: string, args: unknown) =>
  mk("core.tool_call", "model", { toolCallId: id, name, args })
const result = (id: string, name: string, s: string, isError = false) =>
  mk("core.tool_result", "tool", { toolCallId: id, name, content: text(s), isError })
const usage = (input: number, output: number, cacheRead?: number) =>
  mk("core.budget_usage", "system", {
    tokens: { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}) },
    toolCalls: 0,
    wallMs: 1,
  })
const compaction = (decidedBy: "model" | "threshold", actor: Event["actor"]) =>
  mk("core.compaction", actor, { coversSeq: [1, 2], summary: "s", decidedBy, pinsKept: [] })

describe("metrics：从时间线算指标的纯函数", () => {
  it("切轮：第一轮前的 preamble 并入第一轮，工具执行期间 actor=model 的留痕不另起一轮", () => {
    seq = 0
    const tl = [
      user("hi"),
      mk("core.system_note", "system", { kind: "perception", text: "p" }),
      call("a", "add", {}),
      call("m", "memory", {}),
      result("a", "add", "3"),
      mk("core.memory_op", "model", { op: "create", path: "/memories/x" }),
      result("m", "memory", "ok"),
      say("done"),
      usage(1, 1),
    ]
    const turns = splitModelTurns(tl)
    expect(turns).toHaveLength(2)
    expect(turns[0]?.aftermath.map((e) => e.seq)).toEqual([1, 2, 5, 6, 7])
    expect(turns[1]?.output.map((e) => e.seq)).toEqual([8])
    expect(splitModelTurns([user("only")])).toEqual([])
  })

  it("整理计数：模型 / 阈值分开数，连续数取最长一串里的总数", () => {
    seq = 0
    const tl = [
      user("t"),
      call("1", "x", {}),
      result("1", "x", "r"),
      compaction("threshold", "system"), // 第 1 轮
      call("2", "compact", {}),
      compaction("model", "model"),
      result("2", "compact", "ok"), // 第 2 轮
      call("3", "x", {}),
      result("3", "x", "r"), // 第 3 轮：没整理，断开
      call("4", "compact", {}),
      compaction("model", "model"),
      result("4", "compact", "ok"), // 第 4 轮
      say("end"),
    ]
    expect(countCompactions(tl)).toEqual({ model: 2, threshold: 1, maxConsecutive: 2 })
  })

  it("重复调用：同名同参第二次起每次记 1，键顺序不同视为同参", () => {
    seq = 0
    const tl = [
      call("1", "get", { a: 1, b: 2 }),
      call("2", "get", { b: 2, a: 1 }),
      call("3", "get", { a: 1, b: 3 }),
      call("4", "get", { a: 1, b: 2 }),
      call("5", "put", { a: 1, b: 2 }),
    ]
    expect(countRepeatedToolCalls(tl)).toBe(2)
  })

  it("治理衰减：按第一次整理的位置分窗，只数模型动作", () => {
    seq = 0
    const forbid: PlantedConstraint = {
      id: "no-rm",
      violates: (a) => a.type === "core.tool_call" && a.payload.name === "rm",
    }
    const tl = [
      user("t"),
      call("1", "ls", {}),
      result("1", "ls", "x"),
      say("ok"),
      compaction("threshold", "system"),
      call("2", "rm", {}),
      result("2", "rm", "gone"),
      call("3", "ls", {}),
      say("done"),
    ]
    const v = measureViolations(tl, [forbid])
    expect(v.before).toEqual({ actions: 2, violations: 0, rate: 0 })
    expect(v.after).toEqual({ actions: 3, violations: 1, rate: 1 / 3 })
    // 没整理过：全部算 before，after 全零
    const v2 = measureViolations(tl.slice(0, 4), [forbid])
    expect(v2.after).toEqual({ actions: 0, violations: 0, rate: 0 })
    expect(v2.before.actions).toBe(2)
  })

  it("用量：budget_usage 累加，缓存命中 = cacheRead / 上下文总量；没请求过为 undefined", () => {
    seq = 0
    const t = sumTokens([user("x"), usage(100, 10, 300), usage(50, 5)])
    expect(t).toEqual({ input: 150, output: 15, cacheRead: 300, cacheWrite: 0, total: 465 })
    expect(cacheHitRateOf(t)).toBeCloseTo(300 / 450)
    expect(cacheHitRateOf(sumTokens([user("x")]))).toBeUndefined()
  })

  it("measureTimeline 汇总 + finalTextOf 取最后一段正文", () => {
    seq = 0
    const tl = [
      user("t"),
      say("thinking aloud"),
      call("1", "x", {}),
      result("1", "x", "boom", true),
      usage(10, 5),
      say("final"),
      say("report"),
      usage(20, 5, 10),
    ]
    const m = measureTimeline(tl)
    expect(m.turns).toBe(2)
    expect(m.toolCalls).toBe(1)
    expect(m.toolErrors).toBe(1)
    expect(m.tokens.total).toBe(50)
    expect(m.compactions).toEqual({ model: 0, threshold: 0, maxConsecutive: 0 })
    expect(finalTextOf(tl)).toBe("final\nreport")
    expect(finalTextOf([user("nothing")])).toBe("")
  })
})
