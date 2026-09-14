/**
 * @reinsjs/lowering-fetch —— 降级层只用 fetch 的实现，零依赖、零 node:*。
 *
 * 事件 → 中间表示（分组、后移、trust 标注）→ 线协议请求体；SSE 流 → 事件草稿。
 * 已实现 OpenAI Chat Completions（含 DeepSeek 的 reasoning_content 方言）；Anthropic Messages 与 OpenAI Responses 随 F2 / F3 追加。
 * 每种事件在每条协议的落点见各协议的 LOSS_MATRIX，禁止静默丢弃。
 */
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
  type ChatCompletionsOptions,
  type ChatModelOptions,
  chatCompletions,
  deepseek,
  definitionOf,
  openaiChat,
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
export { type FetchLoweredPayload, FetchLowering, type FetchLoweringOptions } from "./lowering.js"
export {
  BUILTIN_MODELS,
  type ChatDialect,
  endpointOf,
  type FetchApi,
  type FetchModel,
  findBuiltin,
  resolveModel,
  SUPPORTED_APIS,
} from "./models.js"
export { parseSse, type SseMessage } from "./sse.js"
export { costOf, type ModelCost } from "./usage.js"

import type { LossMatrix } from "@reinsjs/core"
import { CHAT_LOSS_MATRIX } from "./chat/loss-matrix.js"

/** api → 事件 type → 可能落点；与 lowering-pi 的 LOSS_MATRIX 同形，逐格对照用 */
export const LOSS_MATRIX: LossMatrix = { "openai-chat": CHAT_LOSS_MATRIX }

/** 查某 api 下某事件 type 的声明落点；ext.* 归到通配项 */
export function declaredLandings(api: string, type: string): readonly import("@reinsjs/core").LandingSpec[] {
  const table = LOSS_MATRIX[api]
  if (!table) return []
  return table[type] ?? (type.startsWith("ext.") ? (table["ext.*"] ?? []) : [])
}
