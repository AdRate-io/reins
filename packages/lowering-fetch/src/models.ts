/**
 * 模型表与解析。只放一张**最小表**（上下文窗口、能力位、价目），`ModelRef` 找不到就抛；宿主用 `models` 选项
 * 声明表外模型或覆盖表内字段（DECISIONS 2026-09-14 立项：表过期不阻塞使用）。
 *
 * 表里的数字来自厂商公开文档（2026-09-14 查阅）；价目是每百万 token 美元，DeepSeek 有峰谷价、存的是峰值价。
 */
import { LoweringError, type ModelRef } from "@reinsjs/core"
import type { ModelCost } from "./usage.js"

/** 本包实现的线协议；F2 / F3 追加 anthropic-messages / openai-responses */
export type FetchApi = "openai-chat" | "anthropic-messages" | "openai-responses"

/** 当前已实现、可发请求的协议；toRequest / stream 遇到别的就抛 unsupported_api */
export const SUPPORTED_APIS: ReadonlySet<string> = new Set<FetchApi>(["openai-chat"])

/** 一个模型在本降级层眼里的全部描述。字段与 LoweringCapabilities 对齐，方言开关单独成组 */
export interface FetchModel {
  provider: string
  id: string
  api: FetchApi
  /** 协议根地址：Chat 在其后接 /chat/completions（OpenAI 给到 …/v1，DeepSeek 给到域名即可） */
  baseUrl: string
  contextWindow: number
  maxOutputTokens: number
  /** 模型会产出 thinking / reasoning */
  reasoning: boolean
  images?: boolean
  cost?: ModelCost
  /** 额外请求头（私有网关鉴权等），与降级层级别的 headers 合并、以模型级为准 */
  headers?: Record<string, string>
  name?: string
  /**
   * 是否接受会话中途的 `role:"system"` 消息（system_note 的 exact 落点）。缺省按协议定：Chat 为 true
   * （OpenAI 官方经 CF 网关、DeepSeek 直连 2026-09-14 均实测到达）。
   */
  midConversationSystem?: boolean
  /**
   * 凭证怎么带。缺省按协议：Chat / Responses 用 `Authorization: Bearer`，Anthropic 用 `x-api-key`。
   * "none" 表示凭证在 headers 里（如 Cloudflare AI Gateway 的 cf-aig-authorization），不再向 apiKey 回调要 key。
   */
  auth?: "bearer" | "x-api-key" | "none"
  /** Chat Completions 方言，只收已验证的扩展（Boss 定：严格按 OpenAI 规范，方言等真有人用再加） */
  chat?: ChatDialect
}

export interface ChatDialect {
  /**
   * DeepSeek 的 `reasoning_content`（2026-09-14 直连实测）：响应里思考正文与 `content` 平级；带 `tools` 的请求里
   * **每条** assistant 消息都必须回传该字段（缺了 400，空串可过），不带 tools 时忽略。开了：读侧 → core.model_thinking，
   * 写侧把自家 thinking 回填、没有就回空串。关着（OpenAI 官方）：thinking 无处可放，矩阵记 dropped。
   */
  reasoningContent?: boolean
}

const DEEPSEEK_BASE = "https://api.deepseek.com"
const OPENAI_BASE = "https://api.openai.com/v1"

/** DeepSeek 峰值价（美元 / 百万 token）；谷时减半，算出的成本是上限 */
const DEEPSEEK_FLASH: FetchModel = {
  provider: "deepseek",
  id: "deepseek-flash",
  api: "openai-chat",
  baseUrl: DEEPSEEK_BASE,
  contextWindow: 1_000_000,
  maxOutputTokens: 384_000,
  reasoning: true,
  images: true,
  cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  chat: { reasoningContent: true },
}

/** 内置最小表。OpenAI 这里只列 Chat 线常用型号，Responses 线（F3）另表 */
export const BUILTIN_MODELS: readonly FetchModel[] = [
  DEEPSEEK_FLASH,
  // 别名：模型列表里只有 deepseek-flash，请求带 deepseek-v4-flash 照样接受、响应报 deepseek-flash
  { ...DEEPSEEK_FLASH, id: "deepseek-v4-flash" },
  {
    provider: "deepseek",
    id: "deepseek-v4-pro",
    api: "openai-chat",
    baseUrl: DEEPSEEK_BASE,
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    reasoning: true,
    images: true,
    cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
    chat: { reasoningContent: true },
  },
  {
    provider: "openai",
    id: "gpt-4o-mini",
    api: "openai-chat",
    baseUrl: OPENAI_BASE,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    reasoning: false,
    images: true,
    cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
  },
  {
    provider: "openai",
    id: "gpt-4.1",
    api: "openai-chat",
    baseUrl: OPENAI_BASE,
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    reasoning: false,
    images: true,
    cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  },
  {
    provider: "openai",
    id: "gpt-4.1-mini",
    api: "openai-chat",
    baseUrl: OPENAI_BASE,
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    reasoning: false,
    images: true,
    cost: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 },
  },
  {
    provider: "openai",
    id: "gpt-5-mini",
    api: "openai-chat",
    baseUrl: OPENAI_BASE,
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    images: true,
    cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  },
]

export function findBuiltin(provider: string, id: string): FetchModel | undefined {
  return BUILTIN_MODELS.find((m) => m.provider === provider && m.id === id)
}

/** 宿主声明的优先于内置表 */
export function resolveModel(ref: ModelRef, extra: readonly FetchModel[] = []): FetchModel {
  const model =
    extra.find((m) => m.provider === ref.provider && m.id === ref.id) ?? findBuiltin(ref.provider, ref.id)
  if (!model) {
    throw new LoweringError(
      "unsupported_model",
      `找不到模型 ${ref.provider}/${ref.id}；内置表只是最小集合，其余请通过 models 选项声明（或用工厂函数）`,
      { provider: ref.provider, id: ref.id },
    )
  }
  if (!SUPPORTED_APIS.has(model.api)) {
    throw new LoweringError(
      "unsupported_api",
      `模型 ${ref.provider}/${ref.id} 走 ${model.api}，本实现目前只支持 ${[...SUPPORTED_APIS].join(" / ")}`,
      { api: model.api },
    )
  }
  return model
}

/** 协议端点：baseUrl 去掉尾部斜杠再接路径 */
export function endpointOf(model: FetchModel): string {
  const base = model.baseUrl.replace(/\/+$/, "")
  switch (model.api) {
    case "openai-chat":
      return `${base}/chat/completions`
    case "anthropic-messages":
      return `${base}/messages`
    case "openai-responses":
      return `${base}/responses`
  }
}
