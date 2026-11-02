/**
 * 背景 + 任务输入配方（core README "Input: background and task in one run"）的可执行版本：README 里的代码就是下面的
 * `briefedInput`，这里用真循环证明两条按序落日志、背景是 host 说明、任务是用户消息（OnSet 建议 7，2026-11-02）。
 */
import { describe, expect, it } from "vitest"
import type { EventDraft } from "./events/create.js"
import { runLoop } from "./loop/run-loop.js"
import type { LoopConfig, RunResult } from "./loop/types.js"
import { InMemoryEventLog } from "./store/in-memory.js"
import { ScriptedLowering, say } from "./testing/scripted-lowering.js"

// ---- 配方本体（与 README 逐字一致，改一处要同步另一处）----

/** Host briefing as a system note, then the actual request. One user message per batch. */
function briefedInput(background: string, request: string): EventDraft[] {
  return [
    { type: "core.system_note", actor: "host", payload: { kind: "host", text: background } },
    { type: "core.user_message", actor: "user", payload: { content: [{ type: "text", text: request }] } },
  ]
}

// ---- 配方本体结束 ----

describe("README 配方：背景 + 任务", () => {
  it("背景说明在前、任务在后，一次写入；模型看到的顺序一致", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [say("On it.")] }])
    const config: LoopConfig = {
      sessionId: "s1",
      log,
      lowering,
      model: { provider: "scripted", id: "scripted" },
    }
    const gen = runLoop({
      ...config,
      input: briefedInput("Ticket #12 was edited by Ana an hour ago.", "Review ticket #12."),
    })
    let step = await gen.next()
    while (!step.done) step = await gen.next()
    expect((step.value as RunResult).status).toBe("done")

    const events = await log.tail("s1", 10)
    const [bg, task] = events.filter((e) => e.type === "core.system_note" || e.type === "core.user_message")
    expect([bg?.type, bg?.actor, task?.type]).toEqual(["core.system_note", "host", "core.user_message"])
    expect(task?.seq).toBe((bg?.seq ?? 0) + 1)
    expect(lowering.requests[0]?.events.map((e) => e.type)).toEqual(["core.system_note", "core.user_message"])
  })
})
