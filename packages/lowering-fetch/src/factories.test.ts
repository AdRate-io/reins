import { describe, expect, it } from "vitest"
import { chatCompletions, deepseek, definitionOf, openaiChat } from "./factories.js"

describe("工厂", () => {
  it("deepseek()：表内模型取内置定义（价目、窗口）、开 reasoning_content 方言、官方地址；能力 thinkingReplay 为真", () => {
    const m = deepseek("deepseek-flash", { apiKey: "k" })
    expect(m.model).toEqual({ provider: "deepseek", id: "deepseek-flash" })
    const caps = m.lowering.capabilities(m.model)
    expect(caps).toMatchObject({
      api: "openai-chat",
      thinkingReplay: true,
      midConversationSystem: true,
      images: true,
    })
    expect(caps.contextWindow).toBe(1_000_000)
  })

  it("deepseek() 表外 id 也能用：保守缺省 + 方言开 + 选项覆盖", () => {
    const m = deepseek("deepseek-next", { apiKey: "k", contextWindow: 256_000 })
    const caps = m.lowering.capabilities(m.model)
    expect(caps.contextWindow).toBe(256_000)
    expect(caps.thinkingReplay).toBe(true)
    expect(caps.images).toBe(true)
  })

  it("openaiChat()：官方地址、无方言、thinkingReplay 假；表外 id 用保守缺省", () => {
    const known = openaiChat("gpt-4o-mini", { apiKey: "k" })
    expect(known.lowering.capabilities(known.model)).toMatchObject({ thinkingReplay: false, images: true })
    const unknown = openaiChat("gpt-99", { apiKey: "k" })
    expect(unknown.lowering.capabilities(unknown.model)).toMatchObject({
      contextWindow: 128_000,
      images: false,
      thinkingReplay: false,
    })
  })

  it("chatCompletions()：任意兼容端点，表外必须给 baseUrl", () => {
    const m = chatCompletions("qwen-max", {
      provider: "qwen",
      baseUrl: "https://dashscope/compatible-mode/v1",
      apiKey: "k",
    })
    expect(m.model.provider).toBe("qwen")
    expect(() => chatCompletions("x", { provider: "nobody", apiKey: "k" })).toThrow(/baseUrl/)
  })

  it("definitionOf：选项里给了 undefined 的字段不覆盖内置值；方言合并", () => {
    // JS 调用方可能传 undefined（类型上不允许），运行时要当"没给"
    const d = definitionOf("deepseek", "deepseek-flash", "openai-chat", {
      contextWindow: undefined,
      chat: { reasoningContent: false },
      baseUrl: "https://proxy/ds",
    } as unknown as Parameters<typeof definitionOf>[3])
    expect(d.contextWindow).toBe(1_000_000)
    expect(d.baseUrl).toBe("https://proxy/ds")
    expect(d.chat).toEqual({ reasoningContent: false })
  })
})
