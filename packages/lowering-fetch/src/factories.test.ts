import { describe, expect, it } from "vitest"
import {
  anthropic,
  anthropicMessages,
  chatCompletions,
  deepseek,
  definitionOf,
  openai,
  openaiChat,
  openaiResponses,
} from "./factories.js"

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

  it("openai()：Responses 线，表内 gpt-5-mini 带价目与推理（同 id 的 Chat 条目不串）；gpt-4.1 非推理以内置为准；表外新型号按推理 / 收图起", () => {
    const mini = openai("gpt-5-mini", { apiKey: "k" })
    expect(mini.model).toEqual({ provider: "openai", id: "gpt-5-mini" })
    expect(mini.lowering.capabilities(mini.model)).toMatchObject({
      api: "openai-responses",
      thinkingReplay: true,
      midConversationSystem: true,
      images: true,
      contextWindow: 400_000,
    })
    const chat = openaiChat("gpt-5-mini", { apiKey: "k" })
    expect(chat.lowering.capabilities(chat.model)).toMatchObject({
      api: "openai-chat",
      thinkingReplay: false,
    })
    const gpt41 = openai("gpt-4.1", { apiKey: "k" })
    expect(gpt41.lowering.capabilities(gpt41.model)).toMatchObject({
      thinkingReplay: false,
      contextWindow: 1_047_576,
    })
    const future = openai("gpt-6", { apiKey: "k" })
    expect(future.lowering.capabilities(future.model)).toMatchObject({
      thinkingReplay: true,
      images: true,
      contextWindow: 128_000,
    })
    // 方言：关掉加密项就没有可回放的推理
    const plain = openai("gpt-5-mini", { apiKey: "k", responses: { encryptedReasoning: false } })
    expect(plain.lowering.capabilities(plain.model).thinkingReplay).toBe(false)
  })

  it("openaiResponses()：任意 Responses 协议端点，表外必须给 baseUrl；definitionOf 按协议精确取内置条目", () => {
    const gw = openaiResponses("gpt-5-mini", {
      provider: "cf",
      baseUrl: "https://gateway.ai.cloudflare.com/v1/acc/gw/openai/v1",
      apiKey: "",
      auth: "none",
      reasoning: true,
    })
    expect(gw.model.provider).toBe("cf")
    expect(() => openaiResponses("x", { provider: "nobody", apiKey: "k" })).toThrow(/baseUrl/)
    expect(definitionOf("openai", "gpt-4o-mini", "openai-chat", {}).api).toBe("openai-chat")
    expect(definitionOf("openai", "gpt-4o-mini", "openai-responses", {}).api).toBe("openai-responses")
    expect(definitionOf("openai", "gpt-4o-mini", "openai-responses", {}).cost).toBeDefined()
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

  it("anthropic()：表内模型带价目；中途 system 按模型族（Opus 5 真、Sonnet 5 / Haiku 假、宿主可覆盖）；taskBudget 只 Opus 5 / Fable 5.1", () => {
    const opus = anthropic("claude-opus-5", { apiKey: "k" })
    expect(opus.model).toEqual({ provider: "anthropic", id: "claude-opus-5" })
    expect(opus.lowering.capabilities(opus.model)).toMatchObject({
      api: "anthropic-messages",
      midConversationSystem: true,
      thinkingReplay: true,
      taskBudget: true,
      images: true,
      contextWindow: 1_000_000,
    })
    const sonnet = anthropic("claude-sonnet-5", { apiKey: "k" })
    expect(sonnet.lowering.capabilities(sonnet.model)).toMatchObject({
      midConversationSystem: false,
      taskBudget: false,
    })
    const haiku = anthropic("claude-haiku-4-5-20251001", { apiKey: "k" })
    expect(haiku.lowering.capabilities(haiku.model)).toMatchObject({
      midConversationSystem: false,
      contextWindow: 200_000,
    })
    const dated = anthropic("claude-opus-5-20260301", { apiKey: "k" })
    expect(dated.lowering.capabilities(dated.model)).toMatchObject({
      midConversationSystem: true,
      taskBudget: true,
    })
    const forced = anthropic("claude-sonnet-5", { apiKey: "k", midConversationSystem: true })
    expect(forced.lowering.capabilities(forced.model).midConversationSystem).toBe(true)
  })

  it("deferredTools（L1）：Anthropic 官方模型缺省真（Haiku 4.5 也支持）；第三方 Anthropic 协议上游缺省假、宿主可声明；其余线一律假", () => {
    expect(
      anthropic("claude-haiku-4-5-20251001", { apiKey: "k" }).lowering.capabilities({
        provider: "anthropic",
        id: "claude-haiku-4-5-20251001",
      }).deferredTools,
    ).toBe(true)
    const ds = anthropicMessages("deepseek-v4-flash", {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "k",
    })
    expect(ds.lowering.capabilities(ds.model).deferredTools).toBe(false)
    const forced = anthropicMessages("deepseek-v4-flash", {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "k",
      anthropic: { deferredTools: true },
    })
    expect(forced.lowering.capabilities(forced.model).deferredTools).toBe(true)
    const gpt = openai("gpt-5-mini", { apiKey: "k" })
    expect(gpt.lowering.capabilities(gpt.model).deferredTools).toBe(false)
    const dsChat = deepseek("deepseek-v4-flash", { apiKey: "k" })
    expect(dsChat.lowering.capabilities(dsChat.model).deferredTools).toBe(false)
  })

  it("anthropicMessages()：任意 Anthropic 协议端点，表外必须给 baseUrl，缺省不推断中途 system、不收图", () => {
    const ds = anthropicMessages("deepseek-v4-flash", {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "k",
      reasoning: true,
      midConversationSystem: true,
    })
    expect(ds.lowering.capabilities(ds.model)).toMatchObject({
      api: "anthropic-messages",
      midConversationSystem: true,
      thinkingReplay: true,
      images: false,
    })
    expect(() => anthropicMessages("x", { provider: "nobody", apiKey: "k" })).toThrow(/baseUrl/)
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
    const a = definitionOf("anthropic", "claude-opus-5", "anthropic-messages", {
      anthropic: { cacheTtl: "1h", betas: undefined },
    } as unknown as Parameters<typeof definitionOf>[3])
    expect(a.anthropic).toEqual({ cacheTtl: "1h" })
    expect(a.cost?.input).toBe(5)
  })
})
