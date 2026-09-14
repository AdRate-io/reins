/**
 * 一行拿到"模型 + 降级层"：`deepseek("deepseek-flash", { apiKey })`、`openaiChat("gpt-4o-mini", { apiKey })`、
 * 任何 OpenAI 兼容端点用 `chatCompletions("qwen-max", { provider: "qwen", baseUrl, apiKey })`。
 * 返回 BoundModel，直接给 `createAgent({ model })`；要多模型共享一个降级层就自己 new FetchLowering。
 *
 * 表内模型取内置定义再按选项覆盖；表外模型用保守缺省（128k 窗口、16k 输出、无推理、不收图），宿主按需覆盖。
 * 本包不读环境变量，apiKey 必填、由宿主决定来源（auth:"none" 时可给空串占位）。
 */
import type { BoundModel } from "@reinsjs/core"
import { FetchLowering, type FetchLoweringOptions } from "./lowering.js"
import { type ChatDialect, type FetchApi, type FetchModel, findBuiltin } from "./models.js"
import type { ModelCost } from "./usage.js"

export interface ChatModelOptions {
  apiKey: string
  /** 协议根地址（Chat 在其后接 /chat/completions）；表内模型缺省用厂商官方地址 */
  baseUrl?: string
  contextWindow?: number
  maxOutputTokens?: number
  reasoning?: boolean
  images?: boolean
  cost?: ModelCost
  /** 上游是否接受中途 role:"system"；Chat 缺省 true */
  midConversationSystem?: boolean
  /** Chat 方言开关，见 models.ts ChatDialect */
  chat?: ChatDialect
  /** 凭证怎么带；网关自带凭证头时用 "none" 并把头放 headers */
  auth?: FetchModel["auth"]
  headers?: Record<string, string>
  /** 铺进请求体的额外字段（max_tokens、temperature、thinking …） */
  requestOptions?: Record<string, unknown>
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  trustMarkers?: boolean
}

export interface ChatCompletionsOptions extends ChatModelOptions {
  /** 用作 ModelRef.provider 与 apiKey 回调的键；表外厂商必填 */
  provider: string
}

const DEFAULTS = { contextWindow: 128_000, maxOutputTokens: 16_384, reasoning: false, images: false }

/** 去掉值为 undefined 的键：exactOptionalPropertyTypes 下"没给"与"给了 undefined"要分开 */
function defined<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never
}

/** 内置定义打底，选项里给了的字段覆盖；表外模型从保守缺省起 */
export function definitionOf(
  provider: string,
  id: string,
  api: FetchApi,
  opts: Omit<ChatModelOptions, "apiKey" | "requestOptions" | "fetch" | "timeoutMs" | "trustMarkers">,
): FetchModel {
  const builtin = findBuiltin(provider, id)
  const base: FetchModel =
    builtin && builtin.api === api ? builtin : { provider, id, api, baseUrl: opts.baseUrl ?? "", ...DEFAULTS }
  if (!builtin && !opts.baseUrl) {
    throw new RangeError(`模型 ${provider}/${id} 不在内置表里，必须给 baseUrl`)
  }
  const chat = base.chat || opts.chat ? { ...base.chat, ...defined(opts.chat ?? {}) } : undefined
  return {
    ...base,
    ...defined({
      baseUrl: opts.baseUrl,
      contextWindow: opts.contextWindow,
      maxOutputTokens: opts.maxOutputTokens,
      reasoning: opts.reasoning,
      images: opts.images,
      cost: opts.cost,
      midConversationSystem: opts.midConversationSystem,
      auth: opts.auth,
      headers: opts.headers,
    }),
    ...(chat ? { chat } : {}),
  }
}

function bound(provider: string, id: string, model: FetchModel, opts: ChatModelOptions): BoundModel {
  const loweringOpts: FetchLoweringOptions = {
    apiKey: (p) => (p === provider ? opts.apiKey : undefined),
    models: [model],
    ...(opts.requestOptions ? { requestOptions: () => opts.requestOptions ?? {} } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.trustMarkers !== undefined ? { trustMarkers: opts.trustMarkers } : {}),
  }
  return { model: { provider, id }, lowering: new FetchLowering(loweringOpts) }
}

/** 任何 OpenAI Chat Completions 兼容端点 */
export function chatCompletions(id: string, opts: ChatCompletionsOptions): BoundModel {
  return bound(opts.provider, id, definitionOf(opts.provider, id, "openai-chat", opts), opts)
}

/** DeepSeek 直连：缺省官方地址、开 reasoning_content 方言（带 tools 时缺它 400） */
export function deepseek(id: string, opts: ChatModelOptions): BoundModel {
  return chatCompletions(id, {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    reasoning: true,
    images: true,
    ...opts,
    chat: { reasoningContent: true, ...opts.chat },
  })
}

/** OpenAI 官方 Chat Completions（Responses 线在 F3 另有 openai()） */
export function openaiChat(id: string, opts: ChatModelOptions): BoundModel {
  return chatCompletions(id, { provider: "openai", baseUrl: "https://api.openai.com/v1", ...opts })
}
