/**
 * ModelRef → pi-ai Model。
 *
 * 只从 providers/<name>.models 取静态模型表（S4：不用 providers/all，它会拉进 Bedrock 与 AWS SDK）。
 * 宿主要用表里没有的模型（代理、私有部署、新发布）时，用 ModelDefinition 以我们自己的词汇描述，
 * 这里补齐 pi-ai 需要的其余字段 —— pi-ai 的 Model 类型不出本包。
 */
import type { Api, Model } from "@earendil-works/pi-ai"
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models"
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models"
import { LoweringError, type ModelRef } from "@reinsjs/core"

/** 本包内部使用的 pi-ai 模型类型 */
export type PiModel = Model<Api>

/** 第一版支持的线协议 */
export const SUPPORTED_APIS: ReadonlySet<string> = new Set(["anthropic-messages", "openai-responses"])

/** 宿主自定义模型：用我们的词汇描述，字段与 LoweringCapabilities 对齐 */
export interface ModelDefinition {
  provider: string
  id: string
  /** "anthropic-messages" | "openai-responses" */
  api: string
  baseUrl: string
  /** 支持 thinking / reasoning */
  reasoning: boolean
  contextWindow: number
  maxOutputTokens: number
  images?: boolean
  name?: string
  /** 每百万 token 美元价；缺省全 0（成本算不出但能跑） */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** 额外请求头，如私有网关的鉴权 */
  headers?: Record<string, string>
  /**
   * 是否接受 messages 里的中途 `role:"system"` 消息（system_note 的 exact 落点）。内置 Anthropic 模型按 id 判定；
   * 第三方 Anthropic 协议上游（如 DeepSeek 的兼容端口，2026-09-08 实测接受）由宿主在此声明，缺省按不支持处理。
   */
  midConversationSystem?: boolean
}

const BUILTIN: Readonly<Record<string, Readonly<Record<string, PiModel>>>> = {
  anthropic: ANTHROPIC_MODELS as unknown as Record<string, PiModel>,
  openai: OPENAI_MODELS as unknown as Record<string, PiModel>,
}

export function definitionToModel(def: ModelDefinition): PiModel {
  const model: PiModel = {
    id: def.id,
    name: def.name ?? def.id,
    api: def.api,
    provider: def.provider,
    baseUrl: def.baseUrl,
    reasoning: def.reasoning,
    input: def.images ? ["text", "image"] : ["text"],
    cost: def.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: def.contextWindow,
    maxTokens: def.maxOutputTokens,
  }
  if (def.headers) model.headers = def.headers
  return model
}

export function resolveModel(ref: ModelRef, extra: readonly PiModel[] = []): PiModel {
  const model =
    extra.find((m) => m.provider === ref.provider && m.id === ref.id) ?? BUILTIN[ref.provider]?.[ref.id]
  if (!model) {
    throw new LoweringError(
      "unsupported_model",
      `unknown model ${ref.provider}/${ref.id}; the built-in table covers only anthropic and openai, declare the rest through the models option`,
      {
        provider: ref.provider,
        id: ref.id,
      },
    )
  }
  if (!SUPPORTED_APIS.has(model.api)) {
    throw new LoweringError(
      "unsupported_api",
      `model ${ref.provider}/${ref.id} speaks ${model.api}, but this implementation supports only anthropic-messages and openai-responses`,
      {
        api: model.api,
      },
    )
  }
  return model
}
