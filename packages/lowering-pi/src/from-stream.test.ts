/**
 * pi-ai 最终消息 → 草稿：工具入参二次编码（OnSet 建议 8）。pi-ai 的 parseStreamingJson 只解一层，
 * 整个入参写成 JSON 文本时 toolCall.arguments 是字符串，与 fetch 版同一规则再解一层。
 */
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { draftsOf } from "./from-stream.js"

const message = (args: unknown): AssistantMessage =>
  ({
    role: "assistant",
    provider: "deepseek",
    api: "openai-completions",
    model: "deepseek-flash",
    content: [{ type: "toolCall", id: "c1", name: "f", arguments: args }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  }) as unknown as AssistantMessage

describe("draftsOf：工具入参", () => {
  it("字符串入参能解成对象 → 用对象并标 meta.argumentsUnwrapped；对象入参原样、不带 meta", () => {
    expect(draftsOf(message(JSON.stringify({ a: 1 })))[0]?.payload).toEqual({
      toolCallId: "c1",
      name: "f",
      args: { a: 1 },
      meta: { argumentsUnwrapped: true },
    })
    expect(draftsOf(message({ a: 1 }))[0]?.payload).toEqual({ toolCallId: "c1", name: "f", args: { a: 1 } })
  })
})
