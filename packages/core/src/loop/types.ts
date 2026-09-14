/**
 * 循环与插座的类型（技术方案 §6、§7、§10）。
 *
 * 三组契约：
 * - Tool：宿主给模型的能力（§10 四个正交维度）；循环只用 name / inputSchema / execute / needsApproval 等少数字段，
 *   其余维度（lazy、resultPolicy、ui…）留给脑子模块与后续期次消费，先把形状定下来。
 * - Socket：脑子与底盘之间唯一的契约，五个钩子。脑子只依赖它，不依赖 runLoop 的实现（P3、P4）。
 * - RunResult / SerializedRunState：暂停是显式返回值，状态小到能放 URL 参数（P6）。
 */
import type { ContentPart, Event, Trust } from "../events/base.js"
import type {
  ApprovalRequestPayload,
  CoreEventOf,
  ErrorPayload,
  TokenUsage,
  ToolCallPayload,
  ToolResultPayload,
} from "../events/core.js"
import type { EventDraft } from "../events/create.js"
import type { EventSchemaRegistry } from "../events/registry.js"
import type {
  LandingRecord,
  LoweredRequest,
  Lowering,
  LoweringCapabilities,
  LoweringDelta,
  ModelRef,
} from "../lowering/types.js"
import type { ProjectionStrategy, TokenEstimator } from "../projection/types.js"
import type { BlobStore, EventLog, MemoryStore } from "../store/types.js"
import type { RetryOptions } from "./retry.js"

// ---- 参与者 ----

/** 主事人：本次 run 代表谁。库只透传给钩子与工具，不解释其字段 */
export interface Principal {
  id: string
  [key: string]: unknown
}

export interface SessionInfo {
  id: string
  /** 本次 run 内的第几轮（从 1 起） */
  turn: number
}

// ---- 工具（§10）----

export type ToolSide = "server" | "client" | "sandbox" | "provider"

/** 工具执行结果的规范形态；execute 可以返回任何值，循环用 normalizeToolOutput 归一 */
export interface ToolResult {
  content: ContentPart[]
  isError?: boolean
}

export interface ToolContext {
  sessionId: string
  toolCallId: string
  principal?: Principal
  log: EventLog
  blobs?: BlobStore
  memory?: MemoryStore
  signal?: AbortSignal
  /** 工具想留痕（如 memory_op）：草稿由循环补齐后、在 tool_result 之前 append */
  emit(draft: EventDraft): void
  /**
   * 宿主本次续跑给**别的会话**（子代理）的审批结论（`ApprovalDecisionInput.sessionId` 指向非本会话的那些），循环不校验、不记事件，
   * 原样转发；`asTool` 把它们交给子 run，多层嵌套逐层下传。没有就缺省（§10.1）
   */
  decisions?: readonly ApprovalDecisionInput[]
  /**
   * 把工具代跑的模型用量（子代理的 run）计入本 run 的预算：只加 `TurnContext.budget.tokensSpent`，父的 budget 模块按总账拦。
   * 不追加父的 budget_usage 事件（那条是感知校准上下文大小的依据）。宿主循环提供；没提供的环境里工具只把用量写进结果
   */
  spend?(usage: TokenUsage): void
}

/**
 * 工具。execute / validate 用"方法签名"而非属性函数：TS 对方法参数做双变检查，
 * 这样 Tool<{ path: string }> 才能放进 Tool[]（即 Tool<unknown>[]）里。
 * needsApproval 是 boolean | 函数 的联合，无法写成方法，带类型入参的工具请用 defineTool() 定义。
 */
export interface Tool<TInput = unknown> {
  name: string
  description: string
  /** JSON Schema 对象，原样交给模型；不绑任何校验库 */
  inputSchema: Record<string, unknown>
  /** 可选的入参校验/转换：返回规范化入参，抛错即视为入参不合法（结果以 isError 告知模型） */
  validate?(input: unknown): TInput
  /** 执行位置；缺省 server。client 表示由宿主前端执行，循环遇到即暂停等结果 */
  side?: ToolSide
  /** 缺省表示本循环不执行（转客户端） */
  execute?(input: TInput, ctx: ToolContext): Promise<unknown> | unknown
  /** 把 execute 的返回值翻译成模型看到的内容片段；缺省规则见 normalizeToolOutput */
  toModelOutput?(output: unknown): ContentPart[]
  /** 结果处置：超限截断或外溢（B4 消费） */
  resultPolicy?: { maxTokens?: number; overflow: "truncate" | "spill" }
  /** 执行前是否要人审批。循环内置兜底：为真且没有任何 Socket 做主时，直接转审批暂停（安全默认值） */
  needsApproval?: boolean | ((input: TInput, ctx: ToolContext) => Promise<boolean> | boolean)
  risk?: "low" | "medium" | "high"
  /**
   * 这个工具**成功**结果事件（tool_result）的 trust；缺省 `DEFAULT_TRUST.tool`（untrusted：翻译给模型时包 `<untrusted>` 标记）。
   * 只有输出等同宿主配置的工具才声明 `"system"`——如 brain 的 `skill_read`（技能是宿主写的说明书，视同系统提示）。
   * 刻意只开 system / untrusted 两档：principal 是用户本人的权威、model 是模型自己的话，工具输出冒充哪一个都不对。
   * 落法只有一份纯函数 `toolResultTrust(tool, isError)`：循环（执行结果、宿主回填的客户端工具结果）与 TanStack 适配器
   * （afterToolCall、toolPhaseComplete）都调它；isError 结果、未知工具、入参不合法、执行抛错一律缺省。
   */
  resultTrust?: Extract<Trust, "system" | "untrusted">
  /** 暴露策略：延迟加载/发现（后续期次） */
  lazy?: boolean
  allowedCallers?: ("direct" | "code")[]
  /** MCP Apps 形态（第三期） */
  ui?: { resourceUri: string }
}

export type ToolCallEvent = CoreEventOf<"core.tool_call">
export type ToolResultDraft = EventDraft<"core.tool_result", ToolResultPayload>

// ---- 插座（§7）----

/** beforeModel 的返回：改投影、增删工具、换系统提示；缺省字段表示不改 */
export interface BeforeModelPatch {
  events?: Event[]
  tools?: Tool[]
  systemPrompt?: string
  /**
   * 本轮工具表里哪些只"向厂商声明、不载入上下文"（按名字；L1）。循环把它翻成 `ToolSpec.deferLoading`，
   * 名字不在最终工具表里的忽略。只在 `ctx.capabilities.deferredTools` 为真时有意义——没有原生落点的降级层会直接不发这些工具。
   * 后一个 Socket 给了就整体替换前一个的；没给就沿用
   */
  deferredTools?: readonly string[]
}

/** 审批请求的规格；toolCallId 由循环填 */
export interface ApprovalRequestSpec {
  policyId: string
  summary: string
}

export type BeforeToolDecision =
  | "proceed"
  | { block: string }
  | { defer: ApprovalRequestSpec }
  | { rewrite: unknown }

export interface HandoffIntent {
  /** 缺省由循环生成 */
  toSessionId?: string
  summary: string
  /** 触发交接的那条用户消息，新会话据此续做 */
  triggerMessage?: string
  reason: string
  /** 谁决定交接：模型（默认，经 handoff 工具）或宿主 */
  by?: "model" | "host"
  /**
   * 新会话开头额外追加的事件草稿（B5）：排在摘要说明（seq 1）之后、触发消息之前，如带过去的 pin。
   * 循环只补齐 id / seq / at / sessionId，不解释内容。
   */
  opening?: EventDraft[]
}

export type TurnDecision =
  | "continue"
  | "stop"
  | { handoff: HandoffIntent }
  | { pause: { reason: "budget" | "host"; note?: string } }

export type MaybePromise<T> = T | Promise<T>

export interface TurnContext {
  session: SessionInfo
  principal?: Principal
  /** 当前投影结果，即模型本轮将看到的事件（可读） */
  events: Event[]
  /** 完整时间线快照（脑子模块回看被折叠的事件时用） */
  timeline: readonly Event[]
  log: EventLog
  blobs?: BlobStore
  memory?: MemoryStore
  /** 本轮可用工具 */
  tools: readonly Tool[]
  model: ModelRef
  /** 本模型支持什么（中途 system、thinking 回放、并行工具…） */
  capabilities: LoweringCapabilities
  budget: {
    contextLimit: number
    /** 投影的裁剪目标 = contextLimit - reserveTokens；估算超过它库就按阈值自动折叠最旧的轮次（感知据此提醒模型） */
    targetTokens: number
    /** 本轮投影的估算 token */
    used: number
    /** 本次 run 累计消耗（输入 + 输出） */
    tokensSpent: number
    turns: number
    toolCalls: number
    /** 距 run 开始的毫秒数；beforeModel 时是本轮开始的读数，模型调用后更新 */
    wallMs: number
    /**
     * 最近一次模型请求的真实用量（B8）：beforeModel 时是上一次请求的（含上次 run，从日志最后一条 budget_usage 读），
     * 模型调用后即本轮的。上下文大小用 contextTokensOf(lastUsage) 算，不是 input
     */
    lastUsage?: TokenUsage
  }
  signal?: AbortSignal
  /** 草稿：无 id / seq / at / sessionId，循环补齐后 append。beforeModel 期间 emit 的本轮即可见 */
  emit(draft: EventDraft): void
}

/**
 * 静态贡献的运行环境（B6）：run 起步时给每个 Socket 看一次，让它按"有哪些存储、给谁跑"决定带不带工具与规则。
 * 只暴露跨请求不变或整个 run 不变的东西；每轮变化的信息（视图、预算）走 TurnContext。
 */
export interface SocketSetup {
  log: EventLog
  blobs?: BlobStore
  memory?: MemoryStore
  model: ModelRef
  principal?: Principal
  /** 宿主自己的工具（尚未并入任何 Socket 的贡献） */
  hostTools: readonly Tool[]
}

/**
 * 静态贡献：常量，或按运行环境算一次的函数（返回 undefined 表示这次不贡献）。
 * 函数可以是异步的（P1）：MCP 模块的工具表要在 run 起步时向服务器 `tools/list` 一次，同步解析不可能成立；
 * 代价只是 `resolveSocketContributions` 变成 async，调用它的三处（循环起步、server 预校验、TanStack 适配器）本就在异步上下文里。
 */
export type StaticContribution<T> = T | ((setup: SocketSetup) => T | undefined | Promise<T | undefined>)

/**
 * 脑子与底盘之间唯一的契约。多个 Socket 按注册顺序执行。
 * 钩子可以不返回（无意见），返回值的合并规则见 runLoop 各处注释。
 *
 * 静态贡献与动态补丁分两条路：
 * - `tools` / `systemPrompt` 是模块给整个 run 的**静态**贡献（如 compact 工具与它的规则提示）。循环起步时并进
 *   工具表与系统提示，整个 run 不变 —— 满足 prompt cache 约束（系统提示与工具表每轮稳定，§9.1），
 *   续跑补齐 pending 调用时也在场，并计入 configHash（恢复时能察觉模块被拆装）。
 * - `beforeModel` 的补丁是**动态**改动（宿主换场景、按 principal 增删工具），每改一次缓存前缀重算，别拿它做每轮的事。
 */
export interface Socket {
  /** 便于日志与排错 */
  name?: string
  /**
   * 模块带给模型的工具，整个 run 不变；与 LoopConfig.tools 同名时以后者为准。
   * 可以是函数：run 起步时按运行环境算一次（如 memory 模块在没有 MemoryStore 时不注册工具，§5"缺则不注册"）。
   */
  tools?: StaticContribution<readonly Tool[]>
  /** 模块的规则提示片段，追加在宿主系统提示之后（空行分隔），整个 run 不变；同样可以是按环境算一次的函数 */
  systemPrompt?: StaticContribution<string>
  beforeModel?(ctx: TurnContext): MaybePromise<BeforeModelPatch | undefined>
  afterModel?(ctx: TurnContext, events: Event[]): MaybePromise<void>
  /**
   * 任一 block / defer 即中止该调用；rewrite 替换入参后继续问下一个 Socket（后面的在 call.payload.args 里看到改写后的入参）。
   * 宿主已批准（approval_decision.approved）的调用再遇到 defer 只是略过、继续问后面的 Socket：批准解决的是"要不要问人"，
   * 排在后面的审批策略仍可 block —— deny 不可被覆盖（§9.7）。
   */
  beforeTool?(
    ctx: TurnContext,
    call: ToolCallEvent,
    tool: Tool | undefined,
  ): MaybePromise<BeforeToolDecision | undefined>
  /** 返回新草稿即替换（如外溢后的指引），结果此时尚未 append */
  afterTool?(
    ctx: TurnContext,
    call: ToolCallEvent,
    result: ToolResultDraft,
  ): MaybePromise<ToolResultDraft | undefined>
  /** 第一个给出意见的 Socket 决定；都无意见时：本轮有工具调用则继续，否则结束 */
  onTurnEnd?(ctx: TurnContext): MaybePromise<TurnDecision | undefined>
}

// ---- 运行状态（§6）----

export type PauseReason = "approval" | "budget" | "host"

export type Interruption =
  | { kind: "approval"; toolCallId: string; request: ApprovalRequestPayload; call: ToolCallPayload }
  | { kind: "client_tool"; toolCallId: string; call: ToolCallPayload }
  | { kind: "budget"; note: string }
  | { kind: "host"; note: string }
  | SubagentInterruption

/**
 * 子代理即工具（§10.1，`asTool`）的暂停冒泡：工具里跑的子 run 暂停了，父 run 不落这条 tool_result（调用留作 pending），
 * 而是整体暂停并把子的中断带给宿主。宿主处理子的审批时，结论带 `sessionId: childSessionId` 放进父的 `decisions` 续跑父 run，
 * 父续跑补齐这条 pending 时工具再续跑子 run。子 run 任何原因的暂停（approval / budget / host）都冒泡，父的 reason 综合取最需要人的那个
 */
export interface SubagentInterruption {
  kind: "subagent"
  toolCallId: string
  call: ToolCallPayload
  childSessionId: string
  /** 子 run 的暂停原因 */
  reason: PauseReason
  /** 子 run 自己的中断（可能再嵌 subagent） */
  interruptions: Interruption[]
  /** 子 run 的可序列化状态，给宿主看（续跑子 run 由工具凭 childSessionId 完成，不需要宿主传回） */
  state: SerializedRunState
}

/**
 * 可序列化的 run 状态。只含引用，内容全部从 EventLog 重读，小到能放 URL 参数或 KV。
 * 配置了密钥时 sig 为 HMAC-SHA256；恢复时先验签，再与日志对账（pending 调用的 ID 与入参摘要）。
 */
export interface SerializedRunState {
  v: 1
  sessionId: string
  lastSeq: number
  pendingToolCallIds: string[]
  /** 模型、工具集、系统提示的摘要；恢复时配置变了要能察觉 */
  configHash: string
  /** pending 调用（id、名、入参）的 SHA-256；批下去的必须是当时看到的那次调用 */
  pendingDigest: string
  sig?: string
}

/** 宿主对某次 pending 调用的审批结论；循环记成 approval_decision 事件后按它办 */
export interface ApprovalDecisionInput {
  toolCallId: string
  approved: boolean
  /** 谁批的：用户标识或策略 ID */
  by: string
  reason?: string
  /**
   * 结论针对哪个会话，缺省本会话。指向别的会话（子代理，见 `SubagentInterruption.childSessionId`）的结论本循环不校验、不记事件，
   * 经 `ToolContext.decisions` 原样转发给工具
   */
  sessionId?: string
}

export type RunResult =
  | { status: "done"; sessionId: string; lastSeq: number }
  | {
      status: "paused"
      sessionId: string
      lastSeq: number
      reason: PauseReason
      interruptions: Interruption[]
      state: SerializedRunState
    }
  | { status: "handoff"; sessionId: string; lastSeq: number; toSessionId: string }
  | { status: "error"; sessionId: string; lastSeq: number; error: CoreEventOf<"core.error"> }

export type ErrorEventPayload = ErrorPayload

// ---- 循环配置 ----

export interface LoopConfig {
  sessionId: string
  log: EventLog
  blobs?: BlobStore
  memory?: MemoryStore
  lowering: Lowering
  model: ModelRef
  tools?: readonly Tool[]
  sockets?: readonly Socket[]
  systemPrompt?: string
  /**
   * 本次 run 要追加的新输入：字符串 / 内容片段 → user_message；也可直接给草稿（如宿主注入 system_note）。
   * 缺省不追加（续跑：日志里有未完成的工具调用就先补齐，再问模型）。
   */
  input?: string | ContentPart[] | EventDraft
  principal?: Principal
  projection?: {
    strategies?: readonly ProjectionStrategy[]
    estimate?: TokenEstimator
    reserveTokens?: number
  }
  /** 缺省内置 core 注册表；有 ext.* 事件时传自己的 */
  registry?: EventSchemaRegistry
  /**
   * 单次 run 的轮数上限，触顶以 paused(budget) 返回。这是循环层的兜底，不是预算模块（B8 才做细粒度预算）。
   * 缺省 100。
   */
  maxTurns?: number
  /** 宿主中止：当前请求停止后以 paused(host) 返回，已产出的内容仍入日志 */
  signal?: AbortSignal
  /**
   * 模型调用遇到瞬断（连接被掐、超时、过载 / 限流 / 5xx）时的有限重试，缺省最多 3 次尝试、1s 起翻倍退避。
   * 只在本次尝试尚未写进任何模型输出时重试；宿主中止与配置错不重试。每次将要重试的失败记一条 core.error（模型不可见）。
   * 传 { maxAttempts: 1 } 关闭。见 retry.ts。
   */
  retry?: RetryOptions
  /** 流式增量，只给 UI 用；日志里只有完整内容块 */
  onDelta?: (delta: LoweringDelta) => void
  /** 每次请求的落点记录（有损与丢弃在此可见），供宿主告警或统计 */
  onLandings?: (records: LandingRecord[], request: LoweredRequest) => void
  /** 交接后宿主重绑对话锚点（聊天窗口、频道等） */
  onHandoff?: (fromSessionId: string, toSessionId: string) => MaybePromise<void>
  /**
   * 恢复：上一次 paused 返回的状态（可来自 URL 参数 / KV）。循环先校验（形状、会话、签名、配置、与日志对账），
   * 不通过抛 RunStateError 且不写日志；通过则 append run_resumed，再从"补齐 pending 调用"接上。
   * 不传也能续跑（同一 sessionId 再跑一次），只是少了这层校验。
   */
  resume?: SerializedRunState
  /** 宿主给 pending 调用的审批结论，先记成 approval_decision 再执行；指向非 pending 调用即拒绝 */
  decisions?: readonly ApprovalDecisionInput[]
  /** 状态签名密钥。给了就签发与校验；没给则状态不签名、恢复不验签（只适合可信环境） */
  secret?: string
  /** 允许在模型 / 工具集 / 系统提示变了之后恢复；缺省拒绝 */
  allowConfigDrift?: boolean
  /**
   * 工具表与上一次 run 相比有增删时，是否追加一条模型可见的 `system_note(kind=host)` 列出增删的工具名（P1，缺省开）。
   * 关掉只是不出说明；每次 run 起步那条模型不可见的 `core.tools_bound` 快照照样记，回放与 eval 靠它知道当时有哪些工具。
   */
  announceToolChanges?: boolean
  /** 测试注入：时间与 id 工厂 */
  now?: () => number
  newId?: (at: number) => string
}
