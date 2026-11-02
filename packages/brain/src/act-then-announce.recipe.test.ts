/**
 * "先做再通知"配方（brain README "Act, then announce" 的可执行版本，2026-11-02，OnSet 建议 9 / 10）。
 *
 * 锁住两件事：① 同批前一个失败时，后面的通知与收尾都被拦下，run 不停、模型下一轮看到失败；
 * ② 全部成功时本轮结束即 done，不再为收尾多请求一轮。注册顺序本身就是配方的一部分。
 */
import {
  type CoreEvent,
  type Event,
  InMemoryEventLog,
  type RunResult,
  runLoop,
  type Socket,
  type Tool,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { approval } from "./approval/index.js"
import { budget } from "./budget/index.js"
import { compact } from "./compact/index.js"
import { haltOnFailure } from "./halt-on-failure/index.js"
import { handoff } from "./handoff/index.js"
import { stopAfter } from "./stop-after/index.js"

// ---- 配方本体（与 README 逐字一致，改一处要同步另一处）----

const sockets = [
  haltOnFailure({ applies: (_call, tool) => tool?.risk !== "low" }), // first: a held-back call never reaches the others
  handoff(),
  stopAfter({ tools: ["end_run"] }), // after handoff, before compact / budget
  compact(),
  budget({ limits: { turns: 30 } }),
  approval({ ask: ["deploy"], allow: ["board_update", "chat_send", "end_run"] }), // last, as always
]

// ---- 用例 ----

const SESSION = "s1"
const MODEL = { provider: "scripted", id: "scripted" }

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<RunResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

function hostTools(executed: string[], boardOk: boolean): Tool[] {
  const mk = (name: string, ok = true): Tool => ({
    name,
    description: "",
    inputSchema: {},
    risk: "medium",
    execute: () => {
      executed.push(name)
      return ok ? "ok" : { content: [{ type: "text", text: "rev stale" }], isError: true }
    },
  })
  return [mk("board_update", boardOk), mk("chat_send"), mk("end_run")]
}

async function run(boardOk: boolean, socketsUnderTest: readonly Socket[]) {
  const log = new InMemoryEventLog()
  const executed: string[] = []
  const lowering = new ScriptedLowering([
    {
      drafts: [
        callTool("b", "board_update", {}),
        callTool("c", "chat_send", {}),
        callTool("e", "end_run", {}),
      ],
    },
    { drafts: [say("rev was stale; will retry")] },
  ])
  const result = await drain(
    runLoop({
      sessionId: SESSION,
      log,
      lowering,
      model: MODEL,
      tools: hostTools(executed, boardOk),
      sockets: socketsUnderTest,
      input: "submit the item",
    }),
  )
  const types: string[] = []
  for await (const e of log.read(SESSION)) types.push((e as CoreEvent).type)
  return { result, executed, requests: lowering.requests.length, types }
}

describe("配方：Act, then announce", () => {
  it("board_update 失败：chat_send 与 end_run 被拦下，run 不停，模型下一轮看到失败", async () => {
    const r = await run(false, sockets)
    expect(r.executed).toEqual(["board_update"])
    expect(r.requests).toBe(2)
    expect(r.result.status).toBe("done")
  })

  it("全部成功：本轮结束即 done，不为收尾多请求一轮", async () => {
    const r = await run(true, sockets)
    expect(r.executed).toEqual(["board_update", "chat_send", "end_run"])
    expect(r.requests).toBe(1)
    expect(r.result.status).toBe("done")
  })
})
