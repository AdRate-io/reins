/**
 * 模型表与解析。只放一张**最小表**（上下文窗口、能力位、价目），`ModelRef` 找不到就抛；宿主用 `models` 选项
 * 声明表外模型或覆盖表内字段（DECISIONS 2026-09-14 立项：表过期不阻塞使用）。
 *
 * 表里的数字来自厂商公开文档（2026-09-14 查阅）；价目是每百万 token 美元，DeepSeek 有峰谷价、存的是峰值价。
 */
import { LoweringError, type ModelRef } from "@reinsjs/core"
import type { ModelCost } from "./usage.js"

/** 本包实现的三条线协议（F1 Chat Completions、F2 Anthropic Messages、F3 OpenAI Responses） */
export type FetchApi = "openai-chat" | "anthropic-messages" | "openai-responses"

/** 当前已实现、可发请求的协议；toRequest / stream 遇到别的就抛 unsupported_api */
export const SUPPORTED_APIS: ReadonlySet<string> = new Set<FetchApi>([
  "openai-chat",
  "anthropic-messages",
  "openai-responses",
])

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
  /** Anthropic Messages 线的请求整形选项（beta 头、缓存断点处置） */
  anthropic?: AnthropicDialect
  /** OpenAI Responses 线的请求整形选项（说明角色、加密推理项） */
  responses?: ResponsesDialect
}

export interface ResponsesDialect {
  /**
   * 系统提示与 system_note 用哪个角色。缺省：推理模型 developer、其它 system（与 lowering-pi 同一选择，矩阵同格）。
   * 第三方 Responses 兼容上游不认 developer 时改 "system"。
   */
  systemRole?: "developer" | "system"
  /**
   * 推理模型是否带 `include: ["reasoning.encrypted_content"]`（缺省 true）。`store: false` 下 OpenAI 不保存推理状态，
   * 只有加密项能把上一轮推理带回下一轮（F0 R3 实测回放接受、伪造 400）；不带则 reasoning 项无法回放、一律 dropped。
   * 第三方兼容上游不认 include 参数时可关。
   */
  encryptedReasoning?: boolean
}

export interface ChatDialect {
  /**
   * DeepSeek 的 `reasoning_content`（2026-09-14 直连实测）：响应里思考正文与 `content` 平级；带 `tools` 的请求里
   * **每条** assistant 消息都必须回传该字段（缺了 400，空串可过），不带 tools 时忽略。开了：读侧 → core.model_thinking，
   * 写侧把自家 thinking 回填、没有就回空串。关着（OpenAI 官方）：thinking 无处可放，矩阵记 dropped。
   */
  reasoningContent?: boolean
}

/**
 * 感知说明殿后（messages 末条是 system）时，"最后一条 user 末块"的断点没处打，B1 实测三种处置（spikes/b1-perception-cache）：
 * - "automatic"（缺省）：改在请求顶层放 `cache_control`（Anthropic 自动缓存：断点落在最后一个可缓存块上），命中率与不注入持平；
 * - "previous-user"：仍打在最后一条 user 的末块上，实测低 3～6 个点（后续请求对不上前一次写入的前缀）；
 * - "drop"：不打。只在上游自己会补自动缓存（如 DeepSeek 的兼容端口）时不吃亏。
 * 把断点留在 system 消息上实测几乎零命中，不提供。
 */
export type MidSystemCacheBreakpoint = "automatic" | "previous-user" | "drop"

export interface AnthropicDialect {
  /**
   * `anthropic-beta` 头的取值，用到才带（F0 结论：中途 system 不需要 beta；某些 beta 会抬高 reasoning_extraction
   * 拒答率）。模型级 `headers["anthropic-beta"]` 若也给了，以 headers 为准。
   */
  betas?: readonly string[]
  /** 是否打缓存断点（system 末块、tools 末项、最后一条 user 末块）。缺省 true；上游不认断点时可关 */
  cacheBreakpoints?: boolean
  /** 断点存活期，缺省 5 分钟（不发 ttl 字段）；"1h" 走 `{ type: "ephemeral", ttl: "1h" }` */
  cacheTtl?: "5m" | "1h"
  /** 说明殿后时的断点处置，缺省 "automatic" */
  midSystemCacheBreakpoint?: MidSystemCacheBreakpoint
  /**
   * 是否走 `defer_loading` + `tool_reference` 的原生延迟加载（L1，2026-09-15 经 CF 网关实测 Haiku 4.5 / Opus 5 均支持、GA 无 beta 头）。
   * 缺省：provider 为 "anthropic" 时开，第三方 Anthropic 协议上游（DeepSeek 兼容端口等）关——它们对这两个字段的态度各异，
   * 宿主实测接受后再显式打开。关着时 deferLoading 的工具不发、引用段展开成文本
   */
  deferredTools?: boolean
}

const DEEPSEEK_BASE = "https://api.deepseek.com"
const ANTHROPIC_BASE = "https://api.anthropic.com/v1"

/** Anthropic 官方价目（美元 / 百万 token，2026-09-15 查阅）；缓存写按 1.25 倍、缓存读按 0.1 倍算（Fable 5.1 读价另有公布值） */
const anthropicModel = (id: string, cost: ModelCost, extra: Partial<FetchModel> = {}): FetchModel => ({
  provider: "anthropic",
  id,
  api: "anthropic-messages",
  baseUrl: ANTHROPIC_BASE,
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  reasoning: true,
  images: true,
  cost,
  ...extra,
})
const HAIKU_4_5 = anthropicModel(
  "claude-haiku-4-5",
  { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { contextWindow: 200_000, maxOutputTokens: 64_000 },
)
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

/** OpenAI Responses 线的型号（价目 2026-09-15 查阅；gpt-5.4 / 5.5 超过 272k 输入有加价档，这里存基础价、成本是下限） */
const responsesModel = (
  id: string,
  cost: ModelCost,
  extra: Partial<FetchModel> & { reasoning: boolean; contextWindow: number; maxOutputTokens: number },
): FetchModel => ({
  provider: "openai",
  id,
  api: "openai-responses",
  baseUrl: OPENAI_BASE,
  images: true,
  cost,
  ...extra,
})
const GPT5 = { reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 }
const GPT5_LARGE = { reasoning: true, contextWindow: 272_000, maxOutputTokens: 128_000 }
const O_SERIES = { reasoning: true, contextWindow: 200_000, maxOutputTokens: 100_000 }

/**
 * 内置最小表。同一 provider + id 可能两条协议各一份（OpenAI 的 gpt-4o-mini 等既能走 Chat 也能走 Responses）：
 * `findBuiltin` 带 api 时精确取（工厂函数总是带），不带时取先列的一份——OpenAI 官方 id 的 Responses 条目列在前，所以
 * `resolveModel({ provider: "openai", id })` 缺省走 OpenAI 的主协议 Responses（F3 起；F1 时只有 Chat 条目），要走 Chat 用
 * `openaiChat()` 或在 `models` 里自己声明。Anthropic 列当前一代 + 常用上一代。
 */
export const BUILTIN_MODELS: readonly FetchModel[] = [
  anthropicModel("claude-fable-5-1", { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }),
  anthropicModel("claude-opus-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }),
  anthropicModel("claude-opus-4-8", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }),
  anthropicModel("claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }),
  HAIKU_4_5,
  // 带日期后缀的正式 id 与短名同一份定义
  { ...HAIKU_4_5, id: "claude-haiku-4-5-20251001" },
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
  // ---- OpenAI Responses 线：OpenAI 官方的主协议，同 id 无协议解析时先取它；Chat 条目在后面
  responsesModel("gpt-5.5", { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }, GPT5_LARGE),
  responsesModel("gpt-5.4", { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }, GPT5_LARGE),
  responsesModel("gpt-5.4-mini", { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 }, GPT5),
  responsesModel("gpt-5.2", { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 }, GPT5),
  responsesModel("gpt-5.1", { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }, GPT5),
  responsesModel("gpt-5", { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }, GPT5),
  responsesModel("gpt-5-mini", { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 }, GPT5),
  responsesModel("gpt-5-nano", { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 }, GPT5),
  responsesModel("o3", { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 }, O_SERIES),
  responsesModel("o4-mini", { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 0 }, O_SERIES),
  responsesModel(
    "gpt-4.1",
    { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
    { reasoning: false, contextWindow: 1_047_576, maxOutputTokens: 32_768 },
  ),
  responsesModel(
    "gpt-4.1-mini",
    { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 },
    { reasoning: false, contextWindow: 1_047_576, maxOutputTokens: 32_768 },
  ),
  responsesModel(
    "gpt-4o-mini",
    { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
    { reasoning: false, contextWindow: 128_000, maxOutputTokens: 16_384 },
  ),
  // ---- OpenAI Chat Completions 线的同款型号（openaiChat() 按协议精确取；无协议解析时上面的 Responses 条目优先）
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

/** 带 api 精确取该协议的条目；不带取先列的一份 */
export function findBuiltin(provider: string, id: string, api?: FetchApi): FetchModel | undefined {
  return BUILTIN_MODELS.find(
    (m) => m.provider === provider && m.id === id && (api === undefined || m.api === api),
  )
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
