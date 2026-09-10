import { describe, expect, it } from "vitest"
import type { Event } from "../events/base.js"
import type { CoreEvent, CoreEventOf } from "../events/core.js"
import { InMemoryEventLog } from "../store/in-memory.js"
import { callTool, ScriptedLowering, say, think } from "../testing/scripted-lowering.js"
import { forkSession } from "./fork.js"
import { runLoop } from "./run-loop.js"
import { defineTool } from "./tools.js"
import type { RunResult } from "./types.js"

const MODEL = { provider: "scripted", id: "scripted" }

let executions = 0
const addTool = defineTool<{ a: number; b: number }>({
  name: "add",
  description: "两数相加",
  inputSchema: { type: "object" },
  execute: ({ a, b }) => {
    executions++
    return a + b
  },
})

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<RunResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}
async function all(log: InMemoryEventLog, sessionId: string): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(sessionId)) out.push(e as CoreEvent)
  return out
}
const types = (events: readonly Event[]) => events.map((e) => e.type.replace("core.", ""))
const texts = (events: readonly CoreEvent[]) =>
  events
    .filter((e): e is CoreEventOf<"core.model_text"> => e.type === "core.model_text")
    .map((e) => e.payload.text)

describe("fork：任意 seq 分叉出新会话，两条会话独立演进", () => {
  it("在轮边界分叉：各自追加不同的对话，原会话不受影响", async () => {
    const log = new InMemoryEventLog()
    // 原会话：一问一答
    await drain(
      runLoop({
        sessionId: "main",
        log,
        lowering: new ScriptedLowering([{ drafts: [say("你好，我是 A 线")] }]),
        model: MODEL,
        input: "你好",
      }),
    )
    const mainBefore = await all(log, "main")
    // 起步的 tools_bound（模型不可见）排在用户消息之前
    expect(types(mainBefore)).toEqual(["tools_bound", "user_message", "model_text", "budget_usage"])

    // 在第 3 条（模型回答）之后分叉
    const { toSessionId } = await forkSession(log, { fromSessionId: "main", atSeq: 3 })
    const forked = await all(log, toSessionId)
    expect(forked.map((e) => [e.seq, e.type, e.sessionId])).toEqual([
      [1, "core.tools_bound", toSessionId],
      [2, "core.user_message", toSessionId],
      [3, "core.model_text", toSessionId],
    ])
    // 事件 id 保留，parentId / pinsKept 之类的会话内引用继续有效
    expect(forked.map((e) => e.id)).toEqual(mainBefore.slice(0, 3).map((e) => e.id))

    // 两边各走一步
    const forkLowering = new ScriptedLowering([{ drafts: [say("这是 B 线的回答")] }])
    const forkResult = await drain(
      runLoop({ sessionId: toSessionId, log, lowering: forkLowering, model: MODEL, input: "B 线继续" }),
    )
    const mainResult = await drain(
      runLoop({
        sessionId: "main",
        log,
        lowering: new ScriptedLowering([{ drafts: [say("这是 A 线的回答")] }]),
        model: MODEL,
        input: "A 线继续",
      }),
    )
    expect(forkResult.status).toBe("done")
    expect(mainResult.status).toBe("done")

    const main = await all(log, "main")
    const fork = await all(log, toSessionId)
    expect(texts(main)).toEqual(["你好，我是 A 线", "这是 A 线的回答"])
    expect(texts(fork)).toEqual(["你好，我是 A 线", "这是 B 线的回答"])
    // 分叉线的模型看到的是：共同前缀 + 自己的新输入，看不到 A 线后来的话
    expect(types(forkLowering.requests[0]?.events ?? [])).toEqual([
      "user_message",
      "model_text",
      "user_message",
    ])
    // seq 各自从分叉点续编，互不干扰（两边第二次起步各多一条 tools_bound）
    expect(main.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(fork.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it("切在 tool_call 与 tool_result 之间：新会话把那次调用当作 pending 重新执行", async () => {
    const log = new InMemoryEventLog()
    executions = 0
    await drain(
      runLoop({
        sessionId: "main",
        log,
        lowering: new ScriptedLowering([
          { drafts: [think("算一下"), callTool("c1", "add", { a: 1, b: 2 })] },
          { drafts: [say("3")] },
        ]),
        model: MODEL,
        tools: [addTool],
        input: "1+2",
      }),
    )
    expect(executions).toBe(1)
    const main = await all(log, "main")
    const callSeq = main.find((e) => e.type === "core.tool_call")?.seq ?? 0
    expect(callSeq).toBe(4)

    // 切在 tool_call 之后、tool_result 之前
    const { toSessionId } = await forkSession(log, {
      fromSessionId: "main",
      atSeq: callSeq,
      toSessionId: "alt",
    })
    const altLowering = new ScriptedLowering([{ drafts: [say("换个说法：等于三")] }])
    const result = await drain(
      runLoop({ sessionId: toSessionId, log, lowering: altLowering, model: MODEL, tools: [addTool] }),
    )
    expect(result.status).toBe("done")
    // 工具在分叉线里又跑了一次，结果与原线一致但事件是新的
    expect(executions).toBe(2)
    const alt = await all(log, "alt")
    // 分叉线自己起步又记了一条 tools_bound，排在补齐 pending 的 tool_result 之前
    expect(types(alt)).toEqual([
      "tools_bound",
      "user_message",
      "model_thinking",
      "tool_call",
      "tools_bound",
      "tool_result",
      "model_text",
      "budget_usage",
    ])
    const altResult = alt[5] as CoreEventOf<"core.tool_result">
    const mainResult = main[4] as CoreEventOf<"core.tool_result">
    expect(altResult.payload).toEqual(mainResult.payload)
    expect(altResult.id).not.toBe(mainResult.id)
    // 原会话一条没变
    expect(await all(log, "main")).toEqual(main)
  })

  it("分叉点越界或目标已有事件：由 EventLog.fork 拒绝", async () => {
    const log = new InMemoryEventLog()
    await drain(
      runLoop({
        sessionId: "main",
        log,
        lowering: new ScriptedLowering([{ drafts: [say("好")] }]),
        model: MODEL,
        input: "问",
      }),
    )
    await expect(forkSession(log, { fromSessionId: "main", atSeq: 99 })).rejects.toMatchObject({
      code: "out_of_range",
    })
    await expect(
      forkSession(log, { fromSessionId: "main", atSeq: 1, toSessionId: "main" }),
    ).rejects.toMatchObject({
      code: "target_not_empty",
    })
  })
})
