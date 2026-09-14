/**
 * @reinsjs/adapter-tanstack-ai —— 脑子作为 TanStack AI 的 chat middleware（B10）。
 *
 * 用法：
 *   chat({
 *     adapter, messages, tools, systemPrompts,
 *     middleware: [reinsMiddleware({ sessionId, log, sockets: [perception(), compact(), …], capabilities: { contextWindow } })],
 *     interrupts: [reinsApprovalInterrupt],   // 装了 approval 模块或有 needsApproval 函数形态的 reins 工具时必须登记
 *   })
 *
 * 模块：
 * - middleware：钩子翻译（onConfig / onChunk / 工具钩子 / 中断边界 → 五个 Socket 方法）
 * - messages：事件 ⇄ ModelMessage（角色只在这里出现）；loss-matrix：本路径的有损声明
 * - assembler：流式 chunk → 完整块草稿
 * - tools：reins 工具 ⇄ TanStack 工具；interrupt：审批的通用中断定义
 * `@tanstack/ai` 的类型只在本包出现（对应包表"@tanstack/ai 隔离在此"）。
 */
export { type AssemblerOrigin, BlockAssembler } from "./assembler.js"
export { fromTanstackContent, fromTanstackToolResult, toTanstackContent, toTanstackParts } from "./content.js"
export {
  REINS_APPROVAL_INTERRUPT_ID,
  type ReinsApprovalInterrupt,
  type ReinsApprovalPayload,
  type ReinsApprovalResponse,
  reinsApprovalInterrupt,
} from "./interrupt.js"
export { type LossEntry, TANSTACK_LOSS_MATRIX } from "./loss-matrix.js"
export {
  COMPACTION_PREFIX,
  type DedupedDrafts,
  dedupeImportedUserMessages,
  framedSystemNote,
  IMPORT_SOURCE,
  type ImportedMessages,
  type ImportOptions,
  type ImportOrigin,
  importModelMessages,
  importRef,
  type LoweredMessages,
  parseArgs,
  type ToModelMessagesOptions,
  toModelMessages,
  trailingUserMessages,
} from "./messages.js"
export {
  type ReinsChatMiddleware,
  type ReinsMiddlewareOptions,
  reinsMiddleware,
  TANSTACK_API,
  TANSTACK_APPROVAL_POLICY,
  TANSTACK_DECIDER,
  toReinsUsage,
} from "./middleware.js"
export { type ReinsSchema, type ReinsSchemaInit, reinsSchema } from "./schema.js"
export {
  isNativeToolView,
  NATIVE_TOOL,
  type NativeToolView,
  type ToolBridge,
  toTanstackTool,
  viewOfTanstackTool,
} from "./tools.js"
