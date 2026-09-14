/**
 * L1 延迟加载在 core 的三块：工具定义引用段（ContentPart）、`BeforeModelPatch.deferredTools` → `ToolSpec.deferLoading` 的接线、
 * 引用段的估算与文本展开。协议落点在各降级层自己的用例里。
 */
import { describe, expect, it } from "vitest"
import { renderToolReference, type ToolReferencePart } from "../events/base.js"
import { createCoreEvent } from "../events/create.js"
import { createCoreRegistry } from "../events/registry.js"
import { estimateTextTokens, roughTokenEstimate } from "../projection/estimate.js"
import { InMemoryEventLog } from "../store/in-memory.js"
import { ScriptedLowering, say } from "../testing/scripted-lowering.js"
import { runLoop } from "./run-loop.js"
import { deferredToolSpecOf, defineTool, normalizeToolOutput, toolSpecOf } from "./tools.js"
import type { LoopConfig, Socket, Tool } from "./types.js"

const MODEL = { provider: "scripted", id: "scripted" }
const tool = (name: string): Tool =>
  defineTool({ name, description: `Tool ${name}`, inputSchema: { type: "object" }, execute: () => name })

const ref: ToolReferencePart = {
  type: "tool_reference",
  name: "g",
  description: "Does g.\nSecond line.",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
}

async function drain(gen: AsyncGenerator<unknown, unknown>) {
  while (!(await gen.next()).done) {
    /* 只要跑完 */
  }
}

describe("工具定义引用段（ToolReferencePart）", () => {
  it("renderToolReference 是唯一的展开写法：标题 + 说明 + 单行 schema", () => {
    expect(renderToolReference(ref)).toBe(
      '### g\nDoes g.\nSecond line.\nInput schema: {"type":"object","properties":{"q":{"type":"string"}}}',
    )
  })

  it("normalizeToolOutput 认引用段；形状不完整的当普通对象 JSON 化", () => {
    expect(normalizeToolOutput([{ type: "text", text: "Loaded" }, ref])).toEqual({
      content: [{ type: "text", text: "Loaded" }, ref],
    })
    const half = [{ type: "tool_reference", name: "g" }]
    expect(normalizeToolOutput(half)).toEqual({ content: [{ type: "text", text: JSON.stringify(half) }] })
  })

  it("估算把引用段按展开后的文本算，不是按图片常量", () => {
    const registry = createCoreRegistry()
    const e = createCoreEvent(registry, {
      type: "core.tool_result",
      actor: "tool",
      payload: { toolCallId: "c1", name: "tool_find", content: [ref], isError: false },
      sessionId: "s",
      seq: 1,
      at: 1,
      id: "e1",
    })
    const n = roughTokenEstimate(e)
    expect(n).toBeGreaterThanOrEqual(estimateTextTokens(renderToolReference(ref)))
    expect(n).toBeLessThan(200)
  })
})

describe("deferredTools 接线", () => {
  it("toolSpecOf 单参（map 直接传会吃下标）；deferredToolSpecOf 只在 deferred 为真时带 deferLoading", () => {
    const t = tool("a")
    expect(toolSpecOf(t)).toEqual({ name: "a", description: "Tool a", inputSchema: { type: "object" } })
    expect(deferredToolSpecOf(t, false)).toEqual(toolSpecOf(t))
    expect(deferredToolSpecOf(t, true)).toEqual({ ...toolSpecOf(t), deferLoading: true })
    expect([t].map(toolSpecOf)[0]).not.toHaveProperty("deferLoading")
  })

  it("beforeModel 的 deferredTools 翻成请求里的 ToolSpec.deferLoading；不在表里的名字忽略；后一个 Socket 整体替换", async () => {
    const run = async (sockets: Socket[]) => {
      const lowering = new ScriptedLowering([{ drafts: [say("ok")] }], {
        capabilities: { deferredTools: true },
      })
      const cfg: LoopConfig = {
        sessionId: "s",
        log: new InMemoryEventLog(),
        lowering,
        model: MODEL,
        tools: [tool("a"), tool("b"), tool("c")],
        sockets,
        input: "go",
      }
      await drain(runLoop(cfg))
      return (lowering.requests[0]?.tools ?? []).map((s) => [s.name, s.deferLoading === true] as const)
    }
    const defer = (names: string[]): Socket => ({
      name: `d-${names.join("")}`,
      beforeModel: () => ({ deferredTools: names }),
    })
    expect(await run([])).toEqual([
      ["a", false],
      ["b", false],
      ["c", false],
    ])
    expect(await run([defer(["b", "ghost"])])).toEqual([
      ["a", false],
      ["b", true],
      ["c", false],
    ])
    // 后一个 Socket 给了就整体替换；没给就沿用
    expect(await run([defer(["b"]), defer(["c"])])).toEqual([
      ["a", false],
      ["b", false],
      ["c", true],
    ])
    expect(await run([defer(["b"]), { name: "noop", beforeModel: () => ({ systemPrompt: "x" }) }])).toEqual([
      ["a", false],
      ["b", true],
      ["c", false],
    ])
  })
})
