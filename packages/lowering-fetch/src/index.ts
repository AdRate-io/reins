/**
 * @reinsjs/lowering-fetch —— 降级层只用 fetch 的实现，零依赖、零 node:*。
 *
 * 事件 → 中间表示（分组、后移、trust 标注）→ 线协议请求体；SSE 流 → 事件草稿。
 * 三条线：OpenAI Chat Completions（含 DeepSeek 的 reasoning_content 方言）、Anthropic Messages、OpenAI Responses。
 * 每种事件在每条协议的落点见各协议的 LOSS_MATRIX，禁止静默丢弃。
 */
export { consumeAnthropicStream, usageOf as anthropicUsageOf } from "./anthropic/from-stream.js"
export { ANTHROPIC_LOSS_MATRIX } from "./anthropic/loss-matrix.js"
export {
  type AnthropicAssistantBlock,
  type AnthropicCacheControl,
  type AnthropicMessage,
  type AnthropicRequestBody,
  type AnthropicTool,
  type AnthropicUserBlock,
  encodeAnthropicRequest,
  MAX_ANTHROPIC_BREAKPOINTS,
} from "./anthropic/to-request.js"
export { capabilitiesOf } from "./capabilities.js"
export { consumeChatStream, usageOf as chatUsageOf } from "./chat/from-stream.js"
export { CHAT_LOSS_MATRIX } from "./chat/loss-matrix.js"
export {
  type ChatContentPart,
  type ChatMessage,
  type ChatRequestBody,
  type ChatTool,
  type ChatToolCall,
  encodeChatRequest,
} from "./chat/to-request.js"
export {
  anthropic,
  anthropicMessages,
  type ChatCompletionsOptions,
  type ChatModelOptions,
  chatCompletions,
  deepseek,
  definitionOf,
  type ModelOptions,
  openai,
  openaiChat,
  openaiResponses,
  type ProviderModelOptions,
} from "./factories.js"
export { DEFAULT_TIMEOUT_MS, HttpError, postJson, requestSignals } from "./http.js"
export {
  eventsToIr,
  foreignOrigin,
  type IrBlock,
  type IrItem,
  type ModelOrigin,
  orderLandings,
  sameOrigin,
} from "./ir.js"
export {
  ANTHROPIC_VERSION,
  type FetchLoweredPayload,
  FetchLowering,
  type FetchLoweringOptions,
} from "./lowering.js"
export {
  type AnthropicDialect,
  BUILTIN_MODELS,
  type ChatDialect,
  endpointOf,
  type FetchApi,
  type FetchModel,
  findBuiltin,
  type MidSystemCacheBreakpoint,
  type ResponsesDialect,
  resolveModel,
  SUPPORTED_APIS,
} from "./models.js"
export { consumeResponsesStream, usageOf as responsesUsageOf } from "./responses/from-stream.js"
export { RESPONSES_LOSS_MATRIX } from "./responses/loss-matrix.js"
export {
  encodeResponsesRequest,
  type ResponsesInputContent,
  type ResponsesInputItem,
  type ResponsesRequestBody,
  type ResponsesTool,
  reasoningItemOf,
} from "./responses/to-request.js"
export { parseSse, type SseMessage } from "./sse.js"
export { costOf, type ModelCost } from "./usage.js"

import type { LossMatrix } from "@reinsjs/core"
import { ANTHROPIC_LOSS_MATRIX } from "./anthropic/loss-matrix.js"
import { CHAT_LOSS_MATRIX } from "./chat/loss-matrix.js"
import { RESPONSES_LOSS_MATRIX } from "./responses/loss-matrix.js"

/** api → 事件 type → 可能落点；与 lowering-pi 的 LOSS_MATRIX 同形，逐格对照用 */
export const LOSS_MATRIX: LossMatrix = {
  "openai-chat": CHAT_LOSS_MATRIX,
  "anthropic-messages": ANTHROPIC_LOSS_MATRIX,
  "openai-responses": RESPONSES_LOSS_MATRIX,
}

/** 查某 api 下某事件 type 的声明落点；ext.* 归到通配项 */
export function declaredLandings(api: string, type: string): readonly import("@reinsjs/core").LandingSpec[] {
  const table = LOSS_MATRIX[api]
  if (!table) return []
  return table[type] ?? (type.startsWith("ext.") ? (table["ext.*"] ?? []) : [])
}
