/**
 * 工具表变化说明的文案（AdRate 建议 15）：一侧不超 20 件逐个列名（旧文案不变）；超了只列 20 个、报总数，
 * 调用过的排第一档、只在模型可见文本里出现过的排第二档 —— 往期工具表不进历史，模型只可能凭记忆去调这些。
 */
import { describe, expect, it } from "vitest"
import type { Event } from "../events/base.js"
import type { CoreEventDraft } from "../events/create.js"
import { createCoreEvent } from "../events/create.js"
import { createCoreRegistry } from "../events/registry.js"
import { renderToolChangeNote, toolsBoundDrafts } from "./tools-bound.js"

const registry = createCoreRegistry()
const SESSION = "s"
const HEAD = "Your available tools changed since the previous run."
const REMOVED = "(no longer callable, even if earlier turns used them)"

/** 按草稿顺序造出时间线（接在 base 之后） */
function timelineOf(drafts: CoreEventDraft[], base: readonly Event[] = []): Event[] {
  return [
    ...base,
    ...drafts.map((d, i) =>
      createCoreEvent(registry, { ...d, sessionId: SESSION, seq: base.length + i + 1, at: i } as never),
    ),
  ]
}

/** 378 件 MCP 工具名（字母序与数字序一致，便于断言"按字母序补足"） */
const mcp = Array.from({ length: 378 }, (_, i) => `tt_${String(i).padStart(3, "0")}`)

const bound = (toolNames: string[]): CoreEventDraft => ({
  type: "core.tools_bound",
  actor: "system",
  payload: { toolNames, configHash: "h" },
})
const call = (id: string, name: string, args: unknown = {}): CoreEventDraft => ({
  type: "core.tool_call",
  actor: "model",
  payload: { toolCallId: id, name, args },
})
const say = (text: string): CoreEventDraft => ({ type: "core.model_text", actor: "model", payload: { text } })

function noteOf(drafts: CoreEventDraft[]): string {
  const note = drafts.find((d) => d.type === "core.system_note")
  if (note?.type !== "core.system_note") throw new Error("no note")
  return note.payload.text
}

/** 期望的前 20 个：按给定顺序排前，其余字母序补足 */
const sampleOf = (first: string[]) => [...first, ...mcp.filter((n) => !first.includes(n))].slice(0, 20)

describe("renderToolChangeNote", () => {
  it("一侧不超 20 件：逐个列名，与旧文案逐字一致（两侧都测到恰好 20）", () => {
    expect(renderToolChangeNote({ added: ["a", "b"], removed: ["c"] })).toBe(
      `${HEAD} Added: a, b. Removed ${REMOVED}: c.`,
    )
    const twenty = mcp.slice(0, 20)
    expect(renderToolChangeNote({ added: twenty, removed: twenty })).toBe(
      `${HEAD} Added: ${twenty.join(", ")}. Removed ${REMOVED}: ${twenty.join(", ")}.`,
    )
  })

  it("恰好 21 件：列 20 个、and 1 more", () => {
    const n21 = mcp.slice(0, 21)
    expect(renderToolChangeNote({ added: [], removed: n21 })).toBe(
      `${HEAD} Removed 21 tools ${REMOVED}, including ${mcp.slice(0, 20).join(", ")}, and 1 more.`,
    )
  })

  it("按档排：前档先列、档内字母序，不在档里的字母序补足", () => {
    const text = renderToolChangeNote({ added: [], removed: mcp }, [
      new Set(["tt_300", "tt_100"]),
      new Set(["tt_200"]),
    ])
    expect(text).toBe(
      `${HEAD} Removed 378 tools ${REMOVED}, including ${sampleOf(["tt_100", "tt_300", "tt_200"]).join(", ")}, and 358 more.`,
    )
  })

  it("档里的超过 20 个也只列 20 个；一侧大一侧小各走各的", () => {
    const text = renderToolChangeNote({ added: mcp, removed: ["x"] }, [new Set(mcp.slice(100, 130))])
    expect(text).toBe(
      `${HEAD} Added 378 tools, including ${mcp.slice(100, 120).join(", ")}, and 358 more. Removed ${REMOVED}: x.`,
    )
  })
})

describe("toolsBoundDrafts：大批增删按时间线分档", () => {
  it("调用过（tool_call / tool_result / tool_reference）排第一档，文本里作为整词出现过的第二档；子串不算", () => {
    const timeline = timelineOf([
      bound(["host_tool", ...mcp]),
      {
        type: "core.user_message",
        actor: "user",
        payload: { content: [{ type: "text", text: "查 tt_010 的数据" }] },
      },
      call("c1", "tt_020"),
      {
        type: "core.tool_result",
        actor: "tool",
        payload: {
          toolCallId: "c1",
          name: "tt_020",
          content: [{ type: "text", text: "ok" }],
          isError: false,
        },
      },
      // lazy-tools 过滤路径：tool_find 的入参与结果文本里带名字（core 不认识 tool_find，只看文本）
      call("c2", "tool_find", { names: ["tt_030"] }),
      {
        type: "core.tool_result",
        actor: "tool",
        payload: {
          toolCallId: "c2",
          name: "tool_find",
          content: [
            { type: "text", text: "### tt_040\nDoes 40." },
            { type: "tool_reference", name: "tt_050", description: "Does 50.", inputSchema: {} },
          ],
          isError: false,
        },
      },
      // 子串：tt_0601 不是 tt_060
      say("tt_0601 与 xtt_070"),
    ])
    const text = noteOf(
      toolsBoundDrafts({ timeline, toolNames: ["host_tool"], configHash: "h2", announce: true }),
    )
    expect(text).toBe(
      `${HEAD} Removed 378 tools ${REMOVED}, including ${sampleOf(["tt_020", "tt_050", "tt_010", "tt_030", "tt_040"]).join(", ")}, and 358 more.`,
    )
  })

  it("入参按值扫（换行后的名字不粘连，字符串入参先解析）；思考与整理摘要也算", () => {
    const timeline = timelineOf([
      bound(mcp),
      call("c1", "host", { plan: "step:\ntt_377" }),
      call("c2", "host", '{"plan":"step:\\ntt_376"}'),
      call("c3", "host", "not json tt_375"),
      { type: "core.model_thinking", actor: "model", payload: { text: "maybe tt_374" } },
      {
        type: "core.compaction",
        actor: "model",
        payload: { coversSeq: [1, 2], summary: "used tt_373", decidedBy: "model", pinsKept: [] },
      },
    ])
    const text = noteOf(toolsBoundDrafts({ timeline, toolNames: [], configHash: "h2", announce: true }))
    expect(text).toContain(
      `including ${["tt_373", "tt_374", "tt_375", "tt_376", "tt_377", "tt_000"].join(", ")},`,
    )
  })

  it("来回过期 / 恢复：以前的变化说明里凑数的名字不算，真调用过的不被挤掉", () => {
    const all = ["host_tool", ...mcp]
    let timeline = timelineOf([bound(all), call("c1", "tt_300"), call("c2", "tt_301"), call("c3", "tt_302")])
    const step = (toolNames: string[], extra: CoreEventDraft[] = []) => {
      const drafts = toolsBoundDrafts({ timeline, toolNames, configHash: "h", announce: true })
      timeline = timelineOf([...drafts, ...extra], timeline)
      return noteOf(drafts)
    }
    step(["host_tool"]) // 过期：列 tt_300～302 + 字母序凑数的 tt_000～016
    step(all, [call("c4", "tt_200")]) // 恢复，之后又用了 tt_200
    const text = step(["host_tool"]) // 再过期
    expect(text).toContain(
      `including ${sampleOf(["tt_200", "tt_300", "tt_301", "tt_302"]).join(", ")}, and 358 more.`,
    )
  })

  it("完整增删照旧记在 meta.toolsChanged，压缩的只是文本", () => {
    const drafts = toolsBoundDrafts({
      timeline: timelineOf([bound(["host_tool"])]),
      toolNames: ["host_tool", ...mcp],
      configHash: "h2",
      announce: true,
    })
    const note = drafts[1]
    if (note?.type !== "core.system_note") throw new Error("no note")
    expect(note.payload.meta).toEqual({ toolsChanged: { added: mcp, removed: [] } })
    expect(note.payload.text).toBe(
      `${HEAD} Added 378 tools, including ${mcp.slice(0, 20).join(", ")}, and 358 more.`,
    )
  })

  it("两侧都不超 20 件或 announce: false 时不扫时间线", () => {
    const timeline = timelineOf([bound(mcp)])
    // lastToolsBound 按下标倒读；扫描用 for…of —— 迭代即抛
    Object.defineProperty(timeline, Symbol.iterator, {
      value: () => {
        throw new Error("scanned")
      },
    })
    expect(() =>
      toolsBoundDrafts({ timeline, toolNames: mcp.slice(0, 360), configHash: "h", announce: true }),
    ).not.toThrow()
    expect(() =>
      toolsBoundDrafts({ timeline, toolNames: [], configHash: "h", announce: false }),
    ).not.toThrow()
    expect(() => toolsBoundDrafts({ timeline, toolNames: [], configHash: "h", announce: true })).toThrow(
      "scanned",
    )
  })
})
