import {
  type CoreEventPayloads,
  type CoreEventType,
  createCoreEvent,
  createCoreRegistry,
  type Event,
  type ToolContext,
  type ToolResult,
} from "@reinsjs/core"
import { describe, expect, it } from "vitest"
import { canonicalArgs, recordedTools } from "./recorded-tools.js"

const registry = createCoreRegistry()
let seq = 0
function mk<T extends CoreEventType>(type: T, actor: Event["actor"], payload: CoreEventPayloads[T]): Event {
  seq++
  return createCoreEvent(registry, { sessionId: "r", seq, at: 1_800_000_000_000 + seq, type, actor, payload })
}
const text = (s: string) => [{ type: "text" as const, text: s }]
const call = (id: string, name: string, args: unknown) =>
  mk("core.tool_call", "model", { toolCallId: id, name, args })
const result = (id: string, name: string, s: string, extra: { isError?: boolean; spilled?: boolean } = {}) =>
  mk("core.tool_result", "tool", {
    toolCallId: id,
    name,
    content: text(s),
    isError: extra.isError ?? false,
    ...(extra.spilled ? { spilled: { blobId: "b1", summary: "big" } } : {}),
  })

/** 录像：list 翻两页（第 1 页录了两次、内容不同）、get 一次、一次被拒没结果、一次外溢 */
function recording(): Event[] {
  seq = 0
  return [
    call("1", "list", { page: 1 }),
    result("1", "list", "page1-first"),
    call("2", "list", { page: 2 }),
    result("2", "list", "page2"),
    call("3", "get", { id: "x" }),
    result("3", "get", "item x"),
    call("4", "disable", { id: "x" }), // 录制时被拒，没有 tool_result
    call("5", "report", { days: 30 }),
    result("5", "report", "preview only", { spilled: true }),
    call("6", "list", { page: 1 }),
    result("6", "list", "page1-second"),
    call("7", "get", { id: "bad" }),
    result("7", "get", "not found", { isError: true }),
  ]
}

const ctx = { sessionId: "s", toolCallId: "t", log: {} as ToolContext["log"], emit() {} } as ToolContext
const run = (
  tools: { name: string; execute?: unknown }[],
  name: string,
  args: unknown,
): Promise<ToolResult> => {
  const tool = tools.find((t) => t.name === name)
  if (!tool?.execute) throw new Error(`没有工具 ${name}`)
  return (tool.execute as (i: unknown, c: ToolContext) => Promise<ToolResult>)(args, ctx)
}

describe("recordedTools：从录像回放确定性工具", () => {
  it("统计：配对数、每工具次数、外溢数、无结果数；每个出现过的工具各建一个", () => {
    const { tools, stats } = recordedTools(recording())
    expect(tools.map((t) => t.name).sort()).toEqual(["get", "list", "report"])
    expect(stats).toEqual({ pairs: 6, byName: { list: 3, get: 2, report: 1 }, spilled: 1, unanswered: 1 })
  })

  it("同名同参逐字匹配：键顺序无关；同参录过多次按顺序轮着给，用完回到第一次", async () => {
    const { tools } = recordedTools(recording())
    expect((await run(tools, "list", { page: 2 })).content).toEqual(text("page2"))
    expect((await run(tools, "list", { page: 1 })).content).toEqual(text("page1-first"))
    expect((await run(tools, "list", { page: 1 })).content).toEqual(text("page1-second"))
    expect((await run(tools, "list", { page: 1 })).content).toEqual(text("page1-first"))
    // 录下的错误结果原样回放（模型当时看到的就是错误）
    const bad = await run(tools, "get", { id: "bad" })
    expect(bad.isError).toBe(true)
  })

  it("没匹配上：缺省给 isError 的说明；有 fallback 用 fallback；sequence 模式给同名下一条没用过的", async () => {
    const plain = recordedTools(recording()).tools
    const miss = await run(plain, "get", { id: "y" })
    expect(miss.isError).toBe(true)
    expect(miss.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("No recorded response"),
    })

    const withFallback = recordedTools(recording(), {
      fallback: (name, args) => ({ content: text(`synth ${name} ${JSON.stringify(args)}`), isError: false }),
    }).tools
    expect((await run(withFallback, "get", { id: "y" })).content).toEqual(text('synth get {"id":"y"}'))

    const seqMode = recordedTools(recording(), { sequence: true }).tools
    expect((await run(seqMode, "list", { page: 99 })).content).toEqual(text("page1-first"))
    expect((await run(seqMode, "list", { page: 98 })).content).toEqual(text("page2"))
    expect((await run(seqMode, "list", { page: 97 })).content).toEqual(text("page1-second"))
    expect((await run(seqMode, "list", { page: 96 })).isError).toBe(true)
  })

  it("specs 覆盖模型可见声明与风险；only 只建指定工具", () => {
    const { tools } = recordedTools(recording(), {
      only: ["get"],
      specs: {
        get: {
          description: "取一条",
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
          risk: "low",
        },
      },
    })
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ name: "get", description: "取一条", risk: "low" })
    expect(tools[0]?.inputSchema).toEqual({ type: "object", properties: { id: { type: "string" } } })
  })

  it("canonicalArgs：键排序、嵌套与数组保序", () => {
    expect(canonicalArgs({ b: [{ y: 1, x: 2 }], a: null })).toBe('{"a":null,"b":[{"x":2,"y":1}]}')
    expect(canonicalArgs("s")).toBe('"s"')
  })
})
