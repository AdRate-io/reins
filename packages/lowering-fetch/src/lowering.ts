/**
 * FetchLowering：@reinsjs/core 的 Lowering 接口只用 fetch 的实现（零依赖、零 node:*）。
 *
 * 与 lowering-pi 的分工见 DECISIONS 2026-09-14「lowering-fetch 立项」：两包并存，宿主 import 谁用谁。
 * 这里 `LoweredRequest.payload.body` 就是真正发出去的请求体——没有第二跳改写，排查 400 直接看它。
 */
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
import { consumeAnthropicStream } from "./anthropic/from-stream.js"
import { encodeAnthropicRequest, uniformCacheTtl } from "./anthropic/to-request.js"
import { capabilitiesOf } from "./capabilities.js"
import { consumeChatStream } from "./chat/from-stream.js"
import { encodeChatRequest } from "./chat/to-request.js"
import { DEFAULT_TIMEOUT_MS, postJson, requestSignals, touchChunks, touchEach } from "./http.js"
import { eventsToIr } from "./ir.js"
import { endpointOf, type FetchApi, type FetchModel, resolveModel } from "./models.js"
import { consumeResponsesStream } from "./responses/from-stream.js"
import { encodeResponsesRequest } from "./responses/to-request.js"
import { parseSse } from "./sse.js"

/** Anthropic Messages 的协议版本头，当前唯一稳定值 */
export const ANTHROPIC_VERSION = "2023-06-01"

export interface FetchLoweringOptions {
  /** 按 provider 取 key；返回 undefined 视为未配置。本包不读环境变量，由宿主决定来源 */
  apiKey: (provider: string) => string | undefined
  /** 自定义 fetch（测试注入、代理、Workers 绑定）；缺省 globalThis.fetch */
  fetch?: typeof globalThis.fetch
  /** 附加请求头，所有请求都带；模型级 headers 优先 */
  headers?: Record<string, string>
  /** 内置表之外的模型，或覆盖表内同名模型 */
  models?: readonly FetchModel[]
  /**
   * 铺进请求体的额外字段（max_tokens、temperature、DeepSeek 的 thinking / reasoning_effort、OpenAI 的
   * parallel_tool_calls …），键名以厂商文档为准。按模型返回，便于分族配置。messages / tools / model / stream 不可覆盖。
   */
  requestOptions?: (model: ModelRef) => Record<string, unknown>
  /**
   * 本地时限，缺省 600 000 ms：管"发出请求到收到响应头"与"流里任意两帧之间的空档"，不限整条流的总时长
   * （与两家 SDK 一样不掐正在出字的长流）。到点判 error：还没有任何输出时 core 按瞬断重试，流中途已有输出则不重试；
   * 宿主 signal 中止判 aborted。总时长要封顶由宿主自己的 signal 决定
   */
  timeoutMs?: number
  /**
   * trust 标注（技术方案 §14）：trust=untrusted 的事件翻译时包上 `<untrusted source="tool:<name>">…</untrusted>`，
   * 事件本身不动。缺省 true；传 false 关掉是宿主自担提示注入风险
   */
  trustMarkers?: boolean
}

/** 对外暴露的请求体：就是要 POST 的 JSON，鉴权头与 URL 在 stream 时才拼（不进 payload，日志里不落凭证） */
export interface FetchLoweredPayload {
  api: FetchApi
  body: Record<string, unknown>
}

export class FetchLowering implements Lowering<FetchLoweredPayload> {
  private readonly extraModels: readonly FetchModel[]
  private readonly timeoutMs: number

  constructor(private readonly opts: FetchLoweringOptions) {
    this.extraModels = opts.models ?? []
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  capabilities(ref: ModelRef): LoweringCapabilities {
    return capabilitiesOf(resolveModel(ref, this.extraModels))
  }

  toRequest(input: ToRequestInput): LoweredRequest<FetchLoweredPayload> {
    const model = resolveModel(input.model, this.extraModels)
    const capabilities = capabilitiesOf(model)
    const ir = eventsToIr({
      events: input.events,
      target: { provider: model.provider, api: model.api, model: model.id },
      ...(this.opts.trustMarkers !== undefined ? { trustMarkers: this.opts.trustMarkers } : {}),
    })
    const requestOptions = this.opts.requestOptions?.(input.model)
    const encodeInput = {
      ir,
      events: input.events,
      model,
      capabilities,
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(requestOptions ? { requestOptions } : {}),
    }
    switch (model.api) {
      case "openai-chat": {
        const { body, landings } = encodeChatRequest(encodeInput)
        return { model: input.model, capabilities, landings, payload: { api: model.api, body } }
      }
      case "anthropic-messages": {
        const { body, landings } = encodeAnthropicRequest(encodeInput)
        return { model: input.model, capabilities, landings, payload: { api: model.api, body } }
      }
      case "openai-responses": {
        const { body, landings } = encodeResponsesRequest(encodeInput)
        return { model: input.model, capabilities, landings, payload: { api: model.api, body } }
      }
      default:
        throw new LoweringError("unsupported_api", `unsupported wire protocol ${model.api}`, {
          api: model.api,
        })
    }
  }

  async *stream(
    req: LoweredRequest<FetchLoweredPayload>,
    ctx: LoweringStreamContext = {},
  ): AsyncGenerator<CoreEventDraft, LoweringOutcome> {
    const model = resolveModel(req.model, this.extraModels)
    const headers = this.headersFor(model)
    // 时限只管"到响应头"与"流里两帧之间的空档"，不限流的总时长（见 DEFAULT_TIMEOUT_MS）
    const signals = requestSignals(ctx.signal, this.timeoutMs)
    let res: Response
    try {
      res = await postJson({
        url: endpointOf(model),
        headers,
        body: req.payload.body,
        signal: signals.signal,
        ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      })
    } catch (err) {
      signals.dispose()
      throw err
    }
    signals.touch()
    if (!res.body) {
      signals.dispose()
      return {
        stopReason: "error",
        usage: { input: 0, output: 0 },
        errorMessage: "the response has no body",
      }
    }
    const streamInput = {
      messages: touchEach(parseSse(touchChunks(res.body, signals)), signals),
      origin: { provider: model.provider, api: model.api, model: model.id },
      ...(model.cost ? { cost: model.cost } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      timedOut: signals.timedOut,
      timeoutMs: this.timeoutMs,
      // 上游没给缓存写分档时据此定价：只有真发出去的断点全是 1h 才按 1h 算，混用（宿主顶层 cache_control 的 ttl 与本包
      // 断点不同）时一律按 5 分钟价，costUsd 偏低、不偏高（全库审查 #74 返修）
      ...(req.payload.api === "anthropic-messages" && uniformCacheTtl(req.payload.body) === "1h"
        ? { cacheTtl: "1h" as const }
        : {}),
    }
    switch (req.payload.api) {
      case "openai-chat":
        return yield* consumeChatStream(streamInput, ctx)
      case "anthropic-messages":
        return yield* consumeAnthropicStream(streamInput, ctx)
      case "openai-responses":
        return yield* consumeResponsesStream(streamInput, ctx)
      default:
        // touchEach 的 finally 只在消息流被迭代过才走到，这里没迭代，计时器要自己清
        signals.dispose()
        throw new LoweringError("unsupported_api", `unsupported wire protocol ${req.payload.api}`, {
          api: req.payload.api,
        })
    }
  }

  /**
   * 鉴权头按协议缺省（Chat / Responses bearer、Anthropic x-api-key），模型声明 auth:"none" 时凭证由 headers 自带。
   * Anthropic 线固定带 `anthropic-version`，`anthropic-beta` 只在模型声明了 betas 时带（F0 结论：用到才带）；模型级 headers 最后盖。
   */
  private headersFor(model: FetchModel): Record<string, string> {
    const protocol: Record<string, string> = {}
    if (model.api === "anthropic-messages") {
      protocol["anthropic-version"] = ANTHROPIC_VERSION
      const betas = model.anthropic?.betas
      if (betas && betas.length > 0) protocol["anthropic-beta"] = betas.join(",")
    }
    const headers: Record<string, string> = { ...this.opts.headers, ...protocol, ...model.headers }
    const auth = model.auth ?? (model.api === "anthropic-messages" ? "x-api-key" : "bearer")
    if (auth === "none") return headers
    const apiKey = this.opts.apiKey(model.provider)
    if (!apiKey) {
      throw new LoweringError("missing_api_key", `no API key configured for ${model.provider}`, {
        provider: model.provider,
      })
    }
    if (auth === "bearer") headers.authorization = `Bearer ${apiKey}`
    else headers["x-api-key"] = apiKey
    return headers
  }
}
