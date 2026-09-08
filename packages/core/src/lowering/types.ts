/**
 * 降级层接口（技术方案 §11；宪法二：角色只是翻译）。
 *
 * 降级层把投影后的事件翻译成某家 API 的请求，再把流式响应翻译回事件草稿。
 * 它是唯一允许出现"角色"概念的地方。每种事件在每家 API 上落到哪里、有没有损失，
 * 必须在 LossMatrix 里声明，并在每次 toRequest 的 landings 里逐条记录 —— 禁止静默丢弃（P7）。
 *
 * 本文件只有类型；具体实现（如 @reins/lowering-pi）在可选包里，厂商 SDK 类型不得出现在这里。
 */
import type { Event } from "../events/base.js"
import type { TokenUsage } from "../events/core.js"
import type { EventDraft } from "../events/create.js"

/** 模型引用：宿主用它指定"哪家的哪个模型"，具体解析交给降级层实现 */
export interface ModelRef {
  provider: string
  id: string
}

/** 工具声明的模型可见部分。执行、审批、结果处置等维度在工具模型（§10）里，不进降级层 */
export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema 对象；不绑任何校验库 */
  inputSchema: Record<string, unknown>
}

/** 本模型在本 API 上支持什么。脑子模块据此选择等价表达 */
export interface LoweringCapabilities {
  /** 线协议标识，如 "anthropic-messages" / "openai-responses" */
  api: string
  /** 会话中途能否发带正文的 system 消息（S1 结论：按模型族） */
  midConversationSystem: boolean
  /** thinking / reasoning 能否带签名原样回放 */
  thinkingReplay: boolean
  parallelTools: boolean
  /** 服务端 task budget 倒计时（仅部分 Anthropic 模型） */
  taskBudget: boolean
  images: boolean
  contextWindow: number
  maxOutputTokens: number
}

/**
 * 一条事件在某家 API 上的落点。
 * - exact：语义完整落地
 * - lossy：落地了但有损（角色降级、签名缺失等），note 说明损失了什么
 * - dropped：没有下发，note 说明为什么以及信息由谁承载
 */
export type LossKind = "exact" | "lossy" | "dropped"

/** 矩阵中的一种可能落点；when 描述触发条件（如"模型族支持中途 system"） */
export interface LandingSpec {
  kind: LossKind
  /** 落点标识，如 "user" / "system" / "thinking-block" / "reasoning-item" */
  landing: string
  when?: string
  note?: string
}

/** 有损矩阵：api → 事件 type → 可能的落点列表。每个降级层实现导出自己的矩阵，测试据此逐项断言 */
export type LossMatrix = Readonly<Record<string, Readonly<Record<string, readonly LandingSpec[]>>>>

/** 一次 toRequest 中，某条具体事件实际落到了哪里 */
export interface LandingRecord {
  eventId: string
  type: string
  kind: LossKind
  landing: string
  note?: string
}

export interface LoweredRequest<TPayload = unknown> {
  model: ModelRef
  capabilities: LoweringCapabilities
  /** 每条输入事件一条记录，顺序与输入一致 */
  landings: LandingRecord[]
  /** 降级层专有的请求体，对核心不透明 */
  payload: TPayload
}

/** 只取有损与丢弃的记录，供循环写日志或告警 */
export function lossesOf(req: LoweredRequest): LandingRecord[] {
  return req.landings.filter((l) => l.kind !== "exact")
}

export interface ToRequestInput {
  /** 投影后的事件，顺序即模型看到的顺序 */
  events: readonly Event[]
  tools?: readonly ToolSpec[]
  model: ModelRef
  systemPrompt?: string
}

/** 流式增量，只给 UI 实时显示用；日志里只存 *_end 后的完整事件 */
export interface LoweringDelta {
  kind: "text" | "thinking" | "tool_args"
  /** 本次响应内的内容块序号 */
  index: number
  delta: string
}

export interface LoweringStreamContext {
  signal?: AbortSignal
  onDelta?: (delta: LoweringDelta) => void
}

export interface LoweringOutcome {
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted"
  usage: TokenUsage
  /** 降级层按模型价目算出的美元成本；算不出则缺省 */
  costUsd?: number
  errorMessage?: string
  /** 厂商实际用的模型（可能因回退与请求的不同） */
  responseModel?: string
}

/**
 * 绑定了降级层的模型：`anthropic("claude-opus-5", { apiKey })` 这类工厂的返回值，
 * 给 `createAgent({ model })` 一个参数就够。循环本身仍分开接收 model 与 lowering。
 */
export interface BoundModel {
  model: ModelRef
  lowering: Lowering
}

export interface Lowering<TPayload = unknown> {
  capabilities(model: ModelRef): LoweringCapabilities
  toRequest(input: ToRequestInput): LoweredRequest<TPayload>
  /**
   * 发请求并把流式响应翻译成事件草稿；草稿只在内容块完整后产出。
   * 返回值是这次响应的收尾信息（停止原因、用量），由循环记成 budget_usage / error 事件。
   */
  stream(
    req: LoweredRequest<TPayload>,
    ctx?: LoweringStreamContext,
  ): AsyncGenerator<EventDraft, LoweringOutcome>
}
