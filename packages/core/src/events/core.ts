/**
 * 内置事件类型 core.*（技术方案 §4 表）。
 *
 * 每种事件的载荷单独成 interface，命名 `<Type>Payload`，便于 schema 升级时按 type 逐个演进。
 * 版本约定（旧稿 §8，第一版即执行）：
 * - 只追加可选字段 → 不升版本
 * - 改字段语义、删字段、改必填 → 升版本，并在注册表登记 upcast 函数
 * 当前全部为 v1，见 ./registry.ts 的 CORE_SCHEMAS。
 */
import type { ContentPart, Event } from "./base.js"

// ---- 对话内容 ----

/** 用户说话。中途插话不需要特殊机制，再 append 一条即可。 */
export interface UserMessagePayload {
  content: ContentPart[]
}

/** 模型正文。流式增量在降级层聚合，日志里只存完整的一段。 */
export interface ModelTextPayload {
  text: string
}

/** 模型思考。文本可空（加密 reasoning 只有 replay）；签名等回放数据放 EventBase.replay。 */
export interface ModelThinkingPayload {
  text: string
}

// ---- 工具 ----

export interface ToolCallPayload {
  toolCallId: string
  name: string
  /** 模型给的原始入参（已解析为 JSON 值）；校验在工具执行前做，事件里存原样 */
  args: unknown
}

export interface ToolResultPayload {
  toolCallId: string
  /** 冗余存一份工具名，回放时不必反查 tool_call */
  name: string
  content: ContentPart[]
  isError: boolean
  /** 结果外溢到 BlobStore 时填写；此时 content 只留给模型的取回指引 */
  spilled?: { blobId: string; summary: string }
}

// ---- 脑子注入 ----

/**
 * 脑子/宿主注入给模型看的说明。"模型可见 ⟺ 已记录"，所以感知、钉住提示、预算提醒都是事件。
 * 降级时按模型族落到中途 system 或 user 角色（S1 结论），两种落点都在有损矩阵声明。
 */
export interface SystemNotePayload {
  kind: "perception" | "pin" | "budget" | "host"
  text: string
  /**
   * 注入者附带的结构化数据（如感知的各档位读数），**不进模型上下文**：降级层只翻译 text。
   * 给回放界面与 eval 用，免得从文本里反解。可选字段，不升版本。
   */
  meta?: Record<string, unknown>
  /**
   * 本条说明**取代**的旧说明 id（B3）。被取代的 pin 在折叠 / 裁剪时不再自动幸存，也不再因出现在
   * 旧 compaction 的 pinsKept 里而幸存 —— 这是 append-only 日志里"撤销一条钉住"的唯一表达。
   * 折叠之前它照常可见（未折叠的历史原样展示）。可选字段，不升版本。
   */
  supersedes?: string[]
}

// ---- 审批 ----

export interface ApprovalRequestPayload {
  toolCallId: string
  policyId: string
  /** 给审批人看的一句话摘要 */
  summary: string
}

export interface ApprovalDecisionPayload {
  toolCallId: string
  approved: boolean
  /** 谁批的：用户标识、策略 ID 或 "auto" */
  by: string
  reason?: string
}

// ---- 上下文管理 ----

/**
 * 压缩不删原事件，只追加这一条：投影层看到它就用 summary 替代 coversSeq 范围内的事件。
 * decidedBy 区分模型自决（默认路径，P1）与阈值兜底。
 */
export interface CompactionPayload {
  /** 闭区间 [from, to]，按 seq */
  coversSeq: [number, number]
  summary: string
  decidedBy: "model" | "threshold"
  /** 折叠后仍需重注入的钉住事件 id */
  pinsKept: string[]
}

export interface HandoffPayload {
  toSessionId: string
  summary: string
  /** 触发交接的那条用户消息文本，新会话据此续做 */
  triggerMessage?: string
  reason: string
}

/** 模型读写记忆留痕。op 与 Anthropic memory_20250818 工具的 command 同名。 */
export interface MemoryOpPayload {
  op: "view" | "create" | "str_replace" | "insert" | "delete" | "rename"
  path: string
  /** 写类操作涉及的字节数，便于配额统计 */
  bytes?: number
}

// ---- 预算与运行控制 ----

export interface TokenUsage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** 用量是事件，宿主可按会话或用户聚合出配额；remaining 由 budget 模块按上限算出。 */
export interface BudgetUsagePayload {
  tokens: TokenUsage
  toolCalls: number
  wallMs: number
  remaining?: { tokens?: number; toolCalls?: number; wallMs?: number }
}

export interface RunPausedPayload {
  reason: "approval" | "budget" | "host"
  /** 序列化 run 状态的外部引用（宿主 KV 键、URL 参数等），可选 */
  stateRef?: string
}

export interface RunResumedPayload {
  stateRef?: string
  by?: string
}

export interface ErrorPayload {
  /** 粗分类：provider / tool / budget / internal 等，字符串开放给宿主扩展 */
  category: string
  message: string
  retryable: boolean
  detail?: Record<string, unknown>
}

// ---- type 字面量与联合 ----

/** type 字面量 → 载荷。新增内置事件只需在此加一行并在注册表登记。 */
export interface CoreEventPayloads {
  "core.user_message": UserMessagePayload
  "core.model_text": ModelTextPayload
  "core.model_thinking": ModelThinkingPayload
  "core.tool_call": ToolCallPayload
  "core.tool_result": ToolResultPayload
  "core.system_note": SystemNotePayload
  "core.approval_request": ApprovalRequestPayload
  "core.approval_decision": ApprovalDecisionPayload
  "core.compaction": CompactionPayload
  "core.handoff": HandoffPayload
  "core.memory_op": MemoryOpPayload
  "core.budget_usage": BudgetUsagePayload
  "core.run_paused": RunPausedPayload
  "core.run_resumed": RunResumedPayload
  "core.error": ErrorPayload
}

export type CoreEventType = keyof CoreEventPayloads

/** 按 type 取出对应事件类型，如 CoreEventOf<"core.tool_call"> */
export type CoreEventOf<T extends CoreEventType> = Event<T, CoreEventPayloads[T]>

/** 全部内置事件的可判别联合，switch (e.type) 即可收窄 payload */
export type CoreEvent = { [T in CoreEventType]: CoreEventOf<T> }[CoreEventType]

/** 宿主扩展事件：type 必须以 "ext." 开头，载荷由宿主在注册表登记 */
export type ExtEvent = Event<`ext.${string}`, unknown>

/** 日志里可能出现的任何事件 */
export type AnyEvent = CoreEvent | ExtEvent
