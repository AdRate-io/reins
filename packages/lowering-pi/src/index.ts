/**
 * @reinsjs/lowering-pi —— 降级层在 pi-ai 上的实现。
 *
 * 事件 → pi-ai 三角色消息 → Anthropic Messages / OpenAI Responses 线协议；流式响应 → 事件草稿。
 * 每种事件在每家 API 的落点见 LOSS_MATRIX，禁止静默丢弃。
 */
export { capabilitiesOf } from "./capabilities.js"
export { anthropic, type BoundModelOptions, openai } from "./factories.js"
export { consumeStream, draftsOf } from "./from-stream.js"
export { declaredLandings, LOSS_MATRIX } from "./loss-matrix.js"
export { definitionToModel, type ModelDefinition, resolveModel, SUPPORTED_APIS } from "./models.js"
export {
  PiAiLowering,
  type PiAiLoweringOptions,
  type PiLoweredPayload,
  rewritePayload,
} from "./pi-lowering.js"
export {
  framedSystemNote,
  markSystemNote,
  rewriteAnthropicPayload,
  rewriteOpenAIResponsesPayload,
  SYSTEM_NOTE_MARK,
} from "./system-note.js"
export {
  eventsToContext,
  type ModelOrigin,
  type TextReplay,
  type ThinkingReplay,
  type ToolCallReplay,
} from "./to-request.js"
