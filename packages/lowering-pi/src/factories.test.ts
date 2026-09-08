import { describe, expect, it } from "vitest"
import { anthropic, openai } from "./factories.js"

describe("anthropic() / openai() 工厂", () => {
  it("返回绑定好的模型：内置表模型直接能力查询；key 只对本 provider 生效", async () => {
    const m = anthropic("claude-opus-5", { apiKey: "k" })
    expect(m.model).toEqual({ provider: "anthropic", id: "claude-opus-5" })
    const caps = m.lowering.capabilities(m.model)
    expect(caps.api).toBe("anthropic-messages")
    expect(caps.thinkingReplay).toBe(true)
    // 拿这个降级层去跑别家模型会因缺 key 失败，而不是错用 Anthropic 的 key
    const req = m.lowering.toRequest({ events: [], tools: [], model: { provider: "openai", id: "gpt-5.5" } })
    await expect(m.lowering.stream(req).next()).rejects.toThrow(/missing_api_key/)
  })

  it("带 baseUrl 走网关：按 ModelDefinition 登记，能力可覆盖，请求打到网关", async () => {
    const calls: string[] = []
    const fakeFetch: typeof fetch = async (input) => {
      calls.push(String(input))
      return new Response("", { status: 500 })
    }
    const m = anthropic("my-proxy-model", {
      apiKey: "k",
      baseUrl: "https://gw.example/api",
      contextWindow: 123_000,
      fetch: fakeFetch,
    })
    const caps = m.lowering.capabilities(m.model)
    expect(caps.contextWindow).toBe(123_000)
    const req = m.lowering.toRequest({ events: [], tools: [], model: m.model })
    const outcome = await drain(m.lowering.stream(req))
    expect(outcome.stopReason).toBe("error")
    expect(calls[0]).toMatch(/^https:\/\/gw\.example\/api\//)
  })

  it("openai() 缺省开 reasoning（有 encrypted reasoning 可回放），requestOptions 可整体覆盖", () => {
    const m = openai("gpt-5.5", { apiKey: "k" })
    expect(m.lowering.capabilities(m.model).thinkingReplay).toBe(true)
    const off = openai("gpt-5.5", { apiKey: "k", requestOptions: {} })
    expect(off.lowering.capabilities(off.model).thinkingReplay).toBe(false)
  })
})

async function drain<T>(gen: AsyncGenerator<unknown, T>): Promise<T> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}
