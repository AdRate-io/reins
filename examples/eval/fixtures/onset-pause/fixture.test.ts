/**
 * fixture 自检：整理时机的分类器（不依赖数据，始终跑）；世界、切点、回放工具与 runner 接线（依赖本地 data/，没生成就跳过）。
 */
import { COMPACT_RULES, type PerceptionReading, renderPerception } from "@reinsjs/brain"
import { type CoreEventOf, createCoreEvent, createCoreRegistry, type Event, type ToolResult } from "@reinsjs/core"
import { ScriptedLowering, say } from "@reinsjs/core/testing"
import { runEval } from "@reinsjs/eval"
import { describe, expect, it } from "vitest"
import {
  CANDIDATE_COMPACT_RULES,
  compactionTiming,
  loadOnsetWorld,
  nudgeRender,
  ONSET_CUTS,
  onsetDataAvailable,
  onsetPauseFixtures,
  onsetTools,
  seedBefore,
} from "./fixture.ts"

const reg = createCoreRegistry()
let seq = 0
const call = (name: string): Event =>
  createCoreEvent(reg, {
    type: "core.tool_call",
    actor: "model",
    sessionId: "s",
    seq: ++seq,
    payload: { toolCallId: `c${seq}`, name, args: {} },
  } as never)

describe("compactionTiming：整理落在 run 的哪里", () => {
  it("动手之前是 start、干完活之后是 end、两步活之间是 mid；recall 不算干活", () => {
    seq = 0
    const run = [call("compact"), call("board_read"), call("compact"), call("generate_submit"), call("recall"), call("compact")]
    expect(compactionTiming(run, "done").model).toEqual(["start", "mid", "end"])
    expect(compactionTiming(run, "done").workCalls).toBe(2)
  })

  it("一个干活调用都没有的 run 里整理记 end（只汇报就停的收尾）", () => {
    seq = 0
    expect(compactionTiming([call("compact")], "").model).toEqual(["end"])
  })

  it("nudgeRender：<70% 与缺省文字逐字相同，≥70% 多一行收尾前整理", () => {
    const at = (level: number) =>
      ({
        contextUsage: { level, label: "x" },
        contextOverhead: 0,
        autoFoldAt: "85%",
        unfoldedTurns: { level: 0, label: "≤5" },
        compactions: 0,
        sessionTokens: { level: 0, label: "<10k" },
        spilledResults: { level: 0, label: "0" },
      }) satisfies PerceptionReading
    expect(nudgeRender(at(1))).toBe(renderPerception(at(1)))
    expect(nudgeRender(at(2))).toBe(`${renderPerception(at(2))}\n- The window is past 70%: if you are about to finish this run, call \`compact\` first, then reply.`)
  })

  it("候选文案只在现行规则第一条后补两句，其余逐字相同", () => {
    expect(CANDIDATE_COMPACT_RULES).toContain("the end of a run is such a pause")
    expect(CANDIDATE_COMPACT_RULES).toContain("compact first rather than working less")
    expect(CANDIDATE_COMPACT_RULES.startsWith(COMPACT_RULES.slice(0, COMPACT_RULES.indexOf("Do it at a natural pause")))).toBe(true)
    expect(CANDIDATE_COMPACT_RULES.endsWith(COMPACT_RULES.slice(COMPACT_RULES.indexOf("\n- Do not compact")))).toBe(true)
  })
})

describe.skipIf(!onsetDataAvailable())("onset-pause 世界（本地 data/）", () => {
  const world = onsetDataAvailable() ? loadOnsetWorld() : undefined
  const w = () => {
    if (!world) throw new Error("no data")
    return world
  }

  it("整条会话与世界声明：683 条事件、35 件工具、系统提示非空", () => {
    expect(w().session).toHaveLength(683)
    expect(Object.keys(w().specs)).toHaveLength(35)
    expect(w().systemPrompt.length).toBeGreaterThan(1000)
  })

  it("每个切点：输入是那条投递、种子 seq 从 1 连续、OnSet 的感知说明已去掉", () => {
    for (const cut of ONSET_CUTS) {
      const seed = seedBefore(w().session, cut.cutSeq)
      seed.forEach((e, i) => expect(e.seq).toBe(i + 1))
      expect(
        seed.some((e) => e.type === "core.system_note" && (e as CoreEventOf<"core.system_note">).payload.kind === "perception"),
      ).toBe(false)
      expect(w().session.find((e) => e.seq === cut.cutSeq)?.type).toBe("core.user_message")
    }
  })

  it("回放工具：声明里的每件都在；录过的逐字回放；只写工具没录过也回已接受；读没录过回 isError", async () => {
    const tools = onsetTools(w())
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(w().specs).sort())
    const run = async (n: string, args: unknown) =>
      (await tools.find((t) => t.name === n)?.execute?.(args, {} as never)) as ToolResult
    const recordedCall = w().session.find(
      (e) => e.type === "core.tool_call" && (e as CoreEventOf<"core.tool_call">).payload.name === "board_read",
    ) as CoreEventOf<"core.tool_call">
    const recordedResult = w().session.find(
      (e) =>
        e.type === "core.tool_result" &&
        (e as CoreEventOf<"core.tool_result">).payload.toolCallId === recordedCall.payload.toolCallId,
    ) as CoreEventOf<"core.tool_result">
    expect((await run("board_read", recordedCall.payload.args)).content).toEqual(recordedResult.payload.content)
    expect((await run("chat_send", { text: "never recorded" })).isError).toBeUndefined()
    const offRecord = await run("fs_list", { path: "/nowhere" })
    expect(offRecord.isError).toBe(true)
    // 录像外的结果不能露出"回放"（第一轮泄底干扰了停顿判断）
    expect(JSON.stringify(offRecord.content)).not.toMatch(/replay|recorded/i)
  })

  it("runner 接线：只汇报就停的脚本跑 idle 切点，种子原样进日志、完成度 1", async () => {
    const fixture = onsetPauseFixtures(w()).find((f) => f.id === "onset-pause-idle")
    if (!fixture) throw new Error("fixture missing")
    const lowering = new ScriptedLowering([{ drafts: [say("没有待办，停在这里。")] }])
    const report = await runEval({
      fixtures: [{ ...fixture, facts: [] }],
      arms: [{ name: "scripted" }],
      lowering,
      model: { provider: "scripted", id: "scripted" },
    })
    const o = report.outcomes[0]
    expect(o?.metrics.completed).toBe(1)
    expect(o?.timeline.length).toBeGreaterThan(fixture.task.seed?.length ?? 0)
    expect(lowering.requests[0]?.systemPrompt).toContain(w().systemPrompt.slice(0, 50))
  })
})
