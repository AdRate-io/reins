/**
 * 运行中拉取新输入配方（core README "Input that arrives mid-run"）的可执行版本：README 里的代码就是下面的 `mailbox`，
 * 这里用真循环证明：投递在调模型前被写入、看到写入事件才认领、认领后下一个空档不再重复给（OnSet 建议 13，2026-11-06）。
 */
import { describe, expect, it } from "vitest"
import type { Event } from "./events/base.js"
import type { CoreEvent } from "./events/core.js"
import type { EventDraft } from "./events/create.js"
import { runLoop } from "./loop/run-loop.js"
import { defineTool } from "./loop/tools.js"
import type { LoopConfig } from "./loop/types.js"
import { InMemoryEventLog } from "./store/in-memory.js"
import { callTool, ScriptedLowering, say } from "./testing/scripted-lowering.js"

// ---- 配方本体（与 README 逐字一致，改一处要同步另一处）----

/** A host mailbox: offer everything unclaimed at each gap; claim when the loop has written it. */
function mailbox() {
  const waiting = new Map<string, string>()
  return {
    post(id: string, text: string) {
      waiting.set(id, text)
    },
    pullInput: (): EventDraft[] =>
      [...waiting].map(([id, text]) => ({
        type: "core.user_message",
        actor: "user",
        provenance: { source: "mailbox", ref: id },
        payload: { content: [{ type: "text", text }] },
      })),
    claim(event: Event) {
      if (event.provenance?.source === "mailbox" && event.provenance.ref) waiting.delete(event.provenance.ref)
    },
  }
}

// ---- 配方本体结束 ----

describe("README 配方：运行中拉取新输入", () => {
  it("第 1 轮工具执行期间投递的消息在第 2 轮调模型前写入、只写一次", async () => {
    const box = mailbox()
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "check", {})] },
      { drafts: [callTool("c2", "check", {})] },
      { drafts: [say("Switching to plan A.")] },
    ])
    // 第 1 次工具执行期间来了一条投递：模拟"run 进行中别的角色拍板"
    let posted = false
    const check = defineTool<Record<string, never>>({
      name: "check",
      description: "",
      inputSchema: { type: "object" },
      risk: "low",
      execute: () => {
        if (!posted) box.post("d1", "Boss signed off plan A.")
        posted = true
        return "ok"
      },
    })
    const config: LoopConfig = {
      sessionId: "s1",
      log,
      lowering,
      model: { provider: "scripted", id: "scripted" },
      tools: [check],
    }
    for await (const event of runLoop({ ...config, input: "Plan the shoot.", pullInput: box.pullInput }))
      box.claim(event)

    const users: CoreEvent[] = []
    for await (const e of log.read("s1")) if (e.type === "core.user_message") users.push(e as CoreEvent)
    expect(users.map((e) => e.provenance?.ref)).toEqual([undefined, "d1"])
    // 第 2 次模型请求就看见了；第 1 次没有
    const sees = (i: number) => (lowering.requests[i]?.events ?? []).some((e) => e.provenance?.ref === "d1")
    expect([sees(0), sees(1), sees(2)]).toEqual([false, true, true])
  })
})
