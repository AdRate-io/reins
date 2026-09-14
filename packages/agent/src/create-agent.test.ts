import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { type BoundModel, createAgent, defineTool, memoryStore, rawEncoder } from "./index.js"

const add = defineTool<{ a: number; b: number }>({
  name: "add",
  description: "两数相加",
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  execute: ({ a, b }) => a + b,
})

function scripted(): BoundModel {
  return {
    model: { provider: "scripted", id: "scripted" },
    lowering: new ScriptedLowering([
      { drafts: [callTool("c1", "add", { a: 2, b: 3 })] },
      { drafts: [say("答案是 5")] },
    ]),
  }
}

const frames = (text: string) =>
  text
    .split("\n\n")
    .filter(Boolean)
    .map((b) => b.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => l !== undefined)
    .map((l) => JSON.parse(l.slice(6)) as { type: string })

describe("createAgent", () => {
  it("handler 缺省 AG-UI 编码：POST 一次拿到 RUN_STARTED … RUN_FINISHED", async () => {
    const agent = createAgent({
      model: scripted(),
      tools: [add],
      store: memoryStore(),
      handler: { heartbeatMs: 0 },
    })
    const res = await agent.handler(
      new Request("http://t/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "2+3" }),
      }),
    )
    expect(res.status).toBe(200)
    const types = frames(await res.text()).map((f) => f.type)
    expect(types[0]).toBe("RUN_STARTED")
    expect(types.at(-1)).toBe("RUN_FINISHED")
    expect(types).toContain("TOOL_CALL_RESULT")
  })

  it("handler 选项可覆盖编码：推原始事件", async () => {
    const agent = createAgent({
      model: scripted(),
      tools: [add],
      store: memoryStore(),
      handler: { heartbeatMs: 0, encode: () => rawEncoder },
    })
    const res = await agent.handler(
      new Request("http://t/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "2+3" }),
      }),
    )
    const text = await res.text()
    expect(text).toContain("event: start")
    expect(text).toContain('"type":"core.tool_call"')
  })

  it("run()：不经 HTTP 直接跑，缺省新建会话，事件都落在 store.log 里", async () => {
    const store = memoryStore()
    const agent = createAgent({ model: scripted(), tools: [add], store })
    const gen = agent.run({ input: "2+3" })
    const seen: string[] = []
    let result = await gen.next()
    while (!result.done) {
      seen.push(result.value.type)
      result = await gen.next()
    }
    expect(result.value.status).toBe("done")
    expect(seen).toEqual([
      // 起步先落一条模型不可见的工具表快照（首次 run 无上一条可比，不出变化说明）
      "core.tools_bound",
      "core.user_message",
      "core.tool_call",
      "core.tool_result",
      "core.budget_usage",
      "core.model_text",
      "core.budget_usage",
    ])
    const logged = await store.log.tail(result.value.sessionId, 10)
    expect(logged.map((e) => e.type)).toEqual(seen)
    // definition 就是 runLoop 的配置：blobs / memory 从 store 拆出来了
    expect(agent.definition.blobs).toBe(store.blobs)
    expect(agent.definition.memory).toBe(store.memory)
  })
})
