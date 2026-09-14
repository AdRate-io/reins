/**
 * PiAiLowering：@reinsjs/core 的 Lowering 接口在 pi-ai 上的实现。
 *
 * 只导入 api/<api>（流函数）与 providers/<name>.models（静态模型表）子路径（S4）。
 * pi-ai 的类型不出本包：对外暴露的 payload 用我们自己的结构描述。
 */
import type { Api, Context, Model, StreamFunction, StreamOptions } from "@earendil-works/pi-ai"
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages"
import { stream as openaiResponsesStream } from "@earendil-works/pi-ai/api/openai-responses"
import {
  type CoreEventDraft,
  type LoweredRequest,
  type Lowering,
  type LoweringCapabilities,
  LoweringError,
  type LoweringOutcome,
  type LoweringStreamContext,
  type ModelRef,
  type ToRequestInput,
} from "@reinsjs/core"
import { type CapabilityOverrides, capabilitiesOf } from "./capabilities.js"
import { consumeStream } from "./from-stream.js"
import { definitionToModel, type ModelDefinition, type PiModel, resolveModel } from "./models.js"
import {
  type MidSystemCacheBreakpoint,
  type RewriteAnthropicOptions,
  rewriteAnthropicPayload,
  rewriteOpenAIResponsesPayload,
} from "./system-note.js"
import { eventsToContext } from "./to-request.js"

export interface PiAiLoweringOptions {
  /** 按 provider 取 key；返回 undefined 视为未配置。本包不读环境变量，由宿主决定来源 */
  apiKey: (provider: string) => string | undefined
  /** 自定义 fetch（测试注入、代理、Workers 绑定）；缺省 globalThis.fetch */
  fetch?: typeof globalThis.fetch
  /** 附加请求头；值为 null 表示删掉 pi-ai 的默认头 */
  headers?: Record<string, string | null>
  /** 内置表之外的模型 */
  models?: readonly ModelDefinition[]
  /**
   * 透传给 pi-ai 流函数的额外选项（maxTokens、temperature、Anthropic 的 effort / thinkingEnabled、
   * OpenAI 的 reasoningEffort / reasoningSummary 等），键名以 pi-ai 0.85.1 文档为准。按模型返回，便于分族配置。
   * 注意：OpenAI Responses 不给 reasoningEffort 就不开 reasoning，也就没有 thinking 可回放，capabilities 会如实报 false。
   */
  requestOptions?: (model: ModelRef) => Record<string, unknown>
  /**
   * Anthropic：system_note 殿后时 pi-ai 打在它上面的缓存断点怎么处置（见 system-note.ts）。
   * 缺省 "automatic"（去掉块级断点、请求顶层补自动缓存）；"previous-user" / "drop" 供对照或特殊上游。
   */
  midSystemCacheBreakpoint?: MidSystemCacheBreakpoint
  /**
   * trust 标注（技术方案 §14）：trust=untrusted 的事件（工具输出、外部内容）翻译时包上
   * `<untrusted source="tool:<name>">…</untrusted>`，事件本身不动。缺省 true；传 false 关掉是宿主自担提示注入风险
   */
  trustMarkers?: boolean
}

/** 对外暴露的请求体：pi-ai Context 的结构描述，不引用 pi-ai 类型 */
export interface PiLoweredPayload {
  api: string
  context: {
    systemPrompt?: string
    messages: readonly unknown[]
    tools?: readonly unknown[]
  }
}

export class PiAiLowering implements Lowering<PiLoweredPayload> {
  private readonly extraModels: PiModel[]
  /** 宿主自定义模型声明的能力覆盖，键 provider/id；pi-ai 的 Model 上放不下这些字段 */
  private readonly overrides = new Map<string, CapabilityOverrides>()

  constructor(private readonly opts: PiAiLoweringOptions) {
    this.extraModels = (opts.models ?? []).map(definitionToModel)
    for (const def of opts.models ?? []) {
      if (def.midConversationSystem !== undefined) {
        this.overrides.set(`${def.provider}/${def.id}`, { midConversationSystem: def.midConversationSystem })
      }
    }
  }

  capabilities(ref: ModelRef): LoweringCapabilities {
    return this.capabilitiesFor(ref, resolveModel(ref, this.extraModels))
  }

  private capabilitiesFor(ref: ModelRef, model: PiModel): LoweringCapabilities {
    return capabilitiesOf(model, this.requestOptionsFor(ref), this.overrides.get(`${ref.provider}/${ref.id}`))
  }

  private requestOptionsFor(ref: ModelRef): Record<string, unknown> {
    return this.opts.requestOptions?.(ref) ?? {}
  }

  toRequest(input: ToRequestInput): LoweredRequest<PiLoweredPayload> {
    const model = resolveModel(input.model, this.extraModels)
    const capabilities = this.capabilitiesFor(input.model, model)
    const { context, landings } = eventsToContext({
      events: input.events,
      model,
      capabilities,
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(this.opts.trustMarkers !== undefined ? { trustMarkers: this.opts.trustMarkers } : {}),
    })
    return { model: input.model, capabilities, landings, payload: { api: model.api, context } }
  }

  async *stream(
    req: LoweredRequest<PiLoweredPayload>,
    ctx: LoweringStreamContext = {},
  ): AsyncGenerator<CoreEventDraft, LoweringOutcome> {
    const model = resolveModel(req.model, this.extraModels)
    const apiKey = this.opts.apiKey(model.provider)
    if (!apiKey) {
      throw new LoweringError("missing_api_key", `未配置 ${model.provider} 的 API key`, {
        provider: model.provider,
      })
    }
    // toRequest 里放进 payload 的就是 pi-ai Context 本体，这里取回
    const context = req.payload.context as Context
    const options: StreamOptions & Record<string, unknown> = {
      ...this.requestOptionsFor(req.model),
      apiKey,
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(this.opts.headers ? { headers: this.opts.headers } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onPayload: (payload: unknown, m: Model<Api>) =>
        rewritePayload(model.api, payload, m, {
          ...(this.opts.midSystemCacheBreakpoint
            ? { cacheBreakpoint: this.opts.midSystemCacheBreakpoint }
            : {}),
        }),
    }
    const fn = streamFunctionFor(model.api)
    return yield* consumeStream(fn(model, context, options), ctx)
  }
}

function streamFunctionFor(api: string): StreamFunction<Api, StreamOptions> {
  switch (api) {
    case "anthropic-messages":
      return anthropicStream as unknown as StreamFunction<Api, StreamOptions>
    case "openai-responses":
      return openaiResponsesStream as unknown as StreamFunction<Api, StreamOptions>
    default:
      throw new LoweringError("unsupported_api", `不支持的线协议 ${api}`, { api })
  }
}

/** 把带标记的 system_note 改写成各 API 的 system 消息；返回 undefined 表示请求体不变 */
export function rewritePayload(
  api: string,
  payload: unknown,
  model: { reasoning: boolean },
  opts: RewriteAnthropicOptions = {},
): unknown {
  if (api === "anthropic-messages") return rewriteAnthropicPayload(payload, opts)
  if (api === "openai-responses") return rewriteOpenAIResponsesPayload(payload, model)
  return undefined
}
