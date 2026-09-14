/**
 * 一行拿到"模型 + 降级层"：`anthropic("claude-opus-5", { apiKey })`、`openai("gpt-5.5", { apiKey })`。
 * 返回 BoundModel，直接给 `createAgent({ model })`；要更多控制（多模型共享一个降级层、自定义 fetch）就自己 new PiAiLowering。
 *
 * 本包不读环境变量（T7 决策），apiKey 必填、由宿主决定来源。
 * 带 baseUrl 即走代理 / 网关：此时按 ModelDefinition 登记，能力字段给了缺省值，可用 contextWindow 等覆盖。
 */
import type { BoundModel } from "@reinsjs/core"
import type { ModelDefinition } from "./models.js"
import { PiAiLowering, type PiAiLoweringOptions } from "./pi-lowering.js"

export interface BoundModelOptions {
  apiKey: string
  /** 代理或网关地址。Anthropic 在其后接 /v1/messages，OpenAI 接 /responses（网关请给到 …/v1） */
  baseUrl?: string
  /** 透传给 pi-ai 的请求选项（thinkingEnabled、reasoningEffort、maxTokens…） */
  requestOptions?: Record<string, unknown>
  /** 仅 baseUrl 模式下需要：模型能力。缺省 200k 窗口、16k 输出、支持推理与图片 */
  contextWindow?: number
  maxOutputTokens?: number
  reasoning?: boolean
  images?: boolean
  /** 仅 baseUrl 模式：上游是否接受中途 `role:"system"`（system_note 的 exact 落点）。第三方 Anthropic 兼容端口（如 DeepSeek）实测接受时置 true；缺省按不支持、以标签走 user */
  midConversationSystem?: boolean
  fetch?: typeof globalThis.fetch
  headers?: Record<string, string | null>
  /** trust 标注（§14）：untrusted 内容包 <untrusted> 标记。缺省开；关掉是宿主自担风险 */
  trustMarkers?: boolean
}

function bound(
  provider: "anthropic" | "openai",
  api: string,
  id: string,
  opts: BoundModelOptions,
): BoundModel {
  const models: ModelDefinition[] = opts.baseUrl
    ? [
        {
          provider,
          id,
          api,
          baseUrl: opts.baseUrl,
          reasoning: opts.reasoning ?? true,
          contextWindow: opts.contextWindow ?? 200_000,
          maxOutputTokens: opts.maxOutputTokens ?? 16_000,
          images: opts.images ?? true,
          ...(opts.midConversationSystem !== undefined
            ? { midConversationSystem: opts.midConversationSystem }
            : {}),
        },
      ]
    : []
  const loweringOpts: PiAiLoweringOptions = {
    apiKey: (p) => (p === provider ? opts.apiKey : undefined),
    models,
    ...(opts.requestOptions ? { requestOptions: () => opts.requestOptions ?? {} } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.trustMarkers !== undefined ? { trustMarkers: opts.trustMarkers } : {}),
  }
  return { model: { provider, id }, lowering: new PiAiLowering(loweringOpts) }
}

/** Anthropic Messages。缺省开 thinking（模型不支持时 pi-ai 会忽略） */
export function anthropic(id: string, opts: BoundModelOptions): BoundModel {
  return bound("anthropic", "anthropic-messages", id, {
    requestOptions: { thinkingEnabled: true },
    ...opts,
  })
}

/** OpenAI Responses。缺省 reasoningEffort=medium，这样才有可回放的 reasoning（见 T7 决策） */
export function openai(id: string, opts: BoundModelOptions): BoundModel {
  return bound("openai", "openai-responses", id, {
    requestOptions: { reasoningEffort: "medium" },
    ...opts,
  })
}
