/**
 * reins 脑子作为 TanStack AI 的 chat middleware（技术方案 §2"同一插座的三种宿主"、§7、B10）。
 *
 * 循环归 TanStack，日志仍是唯一真源（宪法二）。每个 `chat()` 调用是一次 run，钩子按下面的对应翻译成五个 Socket 方法：
 *
 *   onConfig(init)        读日志（fail-closed 升级）→ 静态贡献并入工具表与系统提示 → 导入客户端新带来的用户消息
 *   onConfig(beforeModel) 投影 → Socket.beforeModel（emit 的说明本轮可见）→ 事件译成 providerMessages 交给适配器
 *   onChunk(modelStream)  流式 chunk 拼成完整块（model_text / model_thinking / tool_call）逐块入日志
 *   onUsage               本次请求用量 → budget_usage（带投影估算，供感知校准）
 *   onInterruptBoundary   afterModel：Socket.afterModel；beforeTools：对每个待执行调用跑 Socket.beforeTool 管线，
 *                         结论缓存给 onBeforeToolCall，defer 以通用中断表达（run 暂停等审批）
 *   onBeforeToolCall      取缓存结论：block → skip（错误结果）、rewrite → transformArgs
 *   onAfterToolCall       结果草稿 → Socket.afterTool（外溢等可替换）→ 留痕先落、结果后落
 *   onToolPhaseComplete   TanStack 自己处理掉的调用（原生审批拒绝、未知工具、客户端回填）补记结果；原生审批请求入日志
 *   onShouldContinue      Socket.onTurnEnd：stop / pause / handoff 都让 TanStack 停下
 *   onInterruptResolution 审批答复 → approval_decision
 *   onFinish              run_ended(done)（已写过终结事件、或日志里还有没执行的调用时不写；handoff 在交接时就落 run_ended）
 *   onAbort / onError     run_paused(host) / core.error + run_ended(error)
 *
 * 与默认循环的已知差异（有损声明，见技术方案 §11 / DECISIONS）：
 * - TanStack 消息无 system 角色，system_note 以 <system_note> 标签走 user；thinking 无同源签名不下发
 * - defer 让整轮工具都等审批（TanStack 在边界暂停不执行任何调用）；默认循环会先执行不需审批的
 * - onTurnEnd 的 "continue" 只在 TanStack 自己也想继续时生效；pause 表现为 run 正常结束 + run_paused 事件
 * - handoff 只做记录与新会话开头，宿主在下一次请求里改用新 sessionId
 * - 模型看到的是日志投影（providerMessages），TanStack 自己的 messages 数组只给客户端 UI 与它的内部对账用
 * - 终结记号（会话运行状态）：写 run_ended，但 tools_bound 不带 marksEnd——InterruptReplaySignal、其它中间件发起的
 *   通用中断等出口不调任何终结钩子，承诺不了"每个 run 恰好一条终结事件"；这类 run 判 unknown 而不是 interrupted。
 *   写的 run_paused 不带 awaiting / stopped（与 state 同）
 */
import {
  type ApprovalDecisionInput,
  assertDecisionsAwaitApproval,
  awaitingOf,
  type BeforeToolDecision,
  type BlobStore,
  BUILTIN_APPROVAL_POLICY,
  type CoreEvent,
  type CoreEventOf,
  computeConfigHash,
  createCoreRegistry,
  createEvent,
  type Event,
  type EventDraft,
  type EventLog,
  type EventSchemaRegistry,
  errorMessageOf,
  estimateTotal,
  type HandoffIntent,
  handoffOpeningDrafts,
  isModelInvisibleByDefault,
  isReplayable,
  type LandingRecord,
  type LoweringCapabilities,
  type MaybePromise,
  type MemoryStore,
  type ModelRef,
  outcomeUnknownText,
  type Principal,
  type ProjectionStrategy,
  pauseDetailOf,
  pendingToolCalls,
  project,
  RunStateError,
  readTimeline,
  resolveReserveTokens,
  resolveSocketContributions,
  resolveSocketPause,
  roughTokenEstimate,
  type Socket,
  type TokenEstimator,
  type TokenUsage,
  type Tool,
  type ToolCallEvent,
  type ToolContext,
  type ToolResult,
  type ToolResultDraft,
  type TurnContext,
  type TurnDecision,
  toolBatchOf,
  toolResultTrust,
  toolStartedAt,
  toolsBoundDrafts,
  uuidv7,
} from "@reinsjs/core"
import {
  type AfterToolCallInfo,
  type AnyTool,
  type ChatMiddleware,
  type ChatMiddlewareConfig,
  type ChatMiddlewareContext,
  DISCOVERY_TOOL_NAME,
  type StreamChunk,
  type SystemPrompt,
  type TokenUsage as TanstackUsage,
  type ToolPhaseCompleteInfo,
} from "@tanstack/ai"
import { GenericInterruptDefinitionRegistryCapability } from "@tanstack/ai/adapter-internals"
import { BlockAssembler } from "./assembler.js"
import { fromTanstackToolResult, withoutImageRefs } from "./content.js"
import {
  REINS_APPROVAL_INTERRUPT_ID,
  type ReinsApprovalInterrupt,
  reinsApprovalInterrupt,
} from "./interrupt.js"
import {
  dedupeImportedUserMessages,
  importModelMessages,
  toModelMessages,
  trailingUserMessages,
} from "./messages.js"
import { isNativeToolView, type ToolBridge, toTanstackTool, viewOfTanstackTool } from "./tools.js"

/** TanStack 原生审批（工具静态 needsApproval）在日志里的策略标识 */
export const TANSTACK_APPROVAL_POLICY = "tanstack.needsApproval"
/** 审批答复者缺省标识 */
export const TANSTACK_DECIDER = "tanstack"
/** 本适配器给 replay.api 与 error.category 用的标识 */
export const TANSTACK_API = "tanstack-ai"

export interface ReinsMiddlewareOptions {
  sessionId: string
  log: EventLog
  blobs?: BlobStore
  memory?: MemoryStore
  sockets?: readonly Socket[]
  principal?: Principal
  /**
   * 模型能力。TanStack 不告诉中间件上下文窗口有多大，而投影裁剪、感知、预算全靠它，所以 contextWindow 必填；
   * 其余缺省按"只有 user / assistant / tool 三角色"的最保守值填
   */
  capabilities: Partial<LoweringCapabilities> & { contextWindow: number }
  /** 缺省内置 core 注册表；有 ext.* 事件时传自己的 */
  registry?: EventSchemaRegistry
  projection?: {
    strategies?: readonly ProjectionStrategy[]
    estimate?: TokenEstimator
    reserveTokens?: number
  }
  /** 每次请求的落点（有损与丢弃在此可见） */
  onLandings?: (records: LandingRecord[]) => void
  /** 每条刚 append 的事件（宿主拿去推前端、审计） */
  onEvent?: (event: Event) => void
  /** 交接后宿主重绑会话（下一次请求用新 sessionId） */
  onHandoff?: (fromSessionId: string, toSessionId: string) => MaybePromise<void>
  /**
   * 是否把非正文类事件（system_note、compaction、审批、预算、暂停…）作为 AG-UI `CUSTOM` chunk 推进 TanStack 流：
   * name = 事件 type，value = 事件本身（与 @reinsjs/ui-agui 的约定一致）。正文类事件 TanStack 自己已经在流里了。缺省开
   */
  emitCustomEvents?: boolean
  /**
   * 告警出口，缺省 console.warn。会告警的降级：审批中断未登记到 `chat({ interrupts })`（需审批的调用按拒绝处理，R7）、
   * 导入客户端消息时有片段翻不动、客户端重发的用户消息被跳过（R5）。缺 BlobStore 由 spill 模块自己告警，不在这里
   */
  warn?: (message: string) => void
  /** 工具表与上一次 run 相比有增删时追加模型可见的说明（P1，缺省开）；快照事件 `core.tools_bound` 一律记 */
  announceToolChanges?: boolean
  /** trust 标注（技术方案 §14）：untrusted 内容（工具输出）翻译时包 `<untrusted source=…>`。缺省开；关掉是宿主自担提示注入风险 */
  trustMarkers?: boolean
  /** 测试注入 */
  now?: () => number
  newId?: (at: number) => string
}

/** 本包给 TanStack 的中间件类型：声明会发出 reins 审批中断，`chat({ interrupts })` 未登记时类型层就会提示 */
export type ReinsChatMiddleware = ChatMiddleware<unknown, ReinsApprovalInterrupt>

/** 事件里 CUSTOM 推送排除的正文类（TanStack 流里已有对应 chunk） */
const CONTENT_TYPES: ReadonlySet<string> = new Set([
  "core.user_message",
  "core.model_text",
  "core.model_thinking",
  "core.tool_call",
  "core.tool_result",
])

type Verdict =
  | { kind: "proceed" }
  | { kind: "rewrite"; args: unknown }
  | { kind: "block"; text: string }
  | { kind: "await" }
  /**
   * 不执行、原样落 text（判定时就定稿，两处落点同一句）：开始动手后中断、没留下结果的不可重放调用落"结果未知"（与 runLoop 同一判据）；
   * reins 工具的 needsApproval 抛错落 "Approval check failed: …"（与 runLoop 同口径）
   */
  | { kind: "unknown"; text: string }

interface TurnState {
  ctx: TurnContext
  /** ctx.batch 的可变本体：模型输出的 tool_call、落日志的 tool_result 在这里登记（held 恒空：defer 让整批暂停） */
  batch: {
    calls: ToolCallEvent[]
    results: CoreEventOf<"core.tool_result">[]
    held: string[]
    resumed: boolean
  }
  /** 本轮送出视图的估算（beforeModel 补丁与注入之后），进 budget_usage.contextEstimate */
  estimate: number
  startedAt: number
  /** 本次模型响应里的 tool_call 数 */
  toolCalls: number
  modelEvents: Event[]
}

interface RunState {
  model: ModelRef
  capabilities: LoweringCapabilities
  registry: EventSchemaRegistry
  lastSeq: number
  startedAt: number
  turns: number
  tokensSpent: number
  toolCallsTotal: number
  /** TanStack 宿主工具（原件），按名字找回 */
  hostTools: Map<string, AnyTool>
  /** 静态贡献解析结果：视图 + 脑子工具，整个 run 不变 */
  baseTools: readonly Tool[]
  systemPrompts: SystemPrompt[]
  bridge: ToolBridge
  /** Socket / 工具经 emit 留的草稿，flush 时落日志 */
  emitted: EventDraft[]
  verdicts: Map<string, Verdict>
  /** 判过 verdict 的调用 toolCallId → 其 tool_call 事件 id：onBeforeToolCall 写 tool_started 时做 parentId，不必再整读时间线 */
  callEventIds: Map<string, string>
  assembler: BlockAssembler
  turn?: TurnState
  /** 已包装成 TanStack 工具的 reins 工具（按名字缓存，保持引用稳定） */
  wrapped: Map<string, AnyTool>
  /** 上一次交给引擎的工具表（onConfig 的返回）：下一次 beforeModel 见到的表与它不同，就是引擎自己换过（lazy 发现） */
  lastTools: AnyTool[]
  /**
   * 宿主是否把 `reinsApprovalInterrupt` 登记到了 `chat({ interrupts })`（R7）。没登记时引擎会在边界抛
   * "not registered on this chat"，run 死在一条永远等不到答复的 run_paused 上；所以 init 就查，没登记则 defer 降级为拒绝
   */
  approvalInterruptRegistered: boolean
  /**
   * 本次请求带来的 TanStack 原生审批答复（toolCallId → 结论），init 从 `config.resume` / `resumeToolState` 读出，
   * beforeTools 边界记成 approval_decision 后清空。原生答复走引擎自己的通道、不经 onInterruptResolution（#5）
   */
  nativeResolutions: Map<string, NativeResolution>
  /**
   * 改参批准被拒的调用（toolCallId → 审批人想要的入参）：原生答复带 `editedArgs` 且与日志里的入参逐值不同。init 算出，
   * 经 `resumeToolState.cancelledToolCallIds` 交给引擎（引擎先查取消再查审批，服务端与客户端工具都落"已取消"、不执行）
   */
  editRefused: Map<string, unknown>
  /** 判过 verdict 的调用 toolCallId → 日志里的入参：onBeforeToolCall 核对引擎将要执行的那份（纵深防御） */
  callArgs: Map<string, unknown>
  /**
   * 引擎自己的"已取消"集合（`resumeToolState.cancelledToolCallIds` 原件，onConfig 时取到）。客户端工具不经
   * onBeforeToolCall，Socket 判拦下的客户端调用只能在 beforeTools 边界放进这个集合：0.53.0 的引擎整个 run 只有这一个
   * Set、每次 onConfig 交的都是它本身，`executeToolCalls` 先查取消再分客户端 / 审批。依赖的是引擎内部的引用共享，
   * 不是公开契约；前面有中间件把它换成副本时就拦不住，toolPhaseComplete 会如实记结果并留 core.error（第三轮返修 B）
   */
  engineCancelled?: Set<string>
  /** 本 run 交给引擎取消的客户端调用 */
  cancelledByReins: Set<string>
  /** 本 run 已写过 run_resumed（通用中断与原生审批的答复共用一条） */
  resumed: boolean
  /**
   * 本 run 已写过终结事件（run_paused / run_ended），在 append 里随落随记。三个终结钩子共用这一个守卫：
   * wait 路径返回后若连接被取消，引擎会在 finally 里再调 onAbort，没有守卫就会在 run_paused(approval) 后面
   * 再追加一条 run_paused(host)，把审批暂停盖掉
   */
  ended: boolean
}

interface NativeResolution {
  approved: boolean
  /** 审批人改过的入参（TanStack 审批答复的 `editedArgs`），没改为 undefined */
  editedArgs?: unknown
}

/** 原生审批中断的 id 形如 `approval_<toolCallId>`（0.53.0 `executeToolCalls` / `buildActionableInterrupts`） */
const NATIVE_APPROVAL_PREFIX = "approval_"

/** 答复（布尔或 `{ approved, editedArgs }` 信封）→ 结论；形状不认得的返回 undefined（引擎随后会以校验失败拒掉整批） */
function nativeResolutionOf(value: unknown): NativeResolution | undefined {
  if (typeof value === "boolean") return { approved: value }
  if (typeof value !== "object" || value === null) return undefined
  const v = value as { approved?: unknown; editedArgs?: unknown }
  if (typeof v.approved !== "boolean") return undefined
  return v.approved && v.editedArgs !== undefined
    ? { approved: true, editedArgs: v.editedArgs }
    : { approved: v.approved }
}

/**
 * 本次请求带来的原生审批答复。两个来源：客户端的 `resume` 项（引擎在 init 之后才校验并应用，所以这里读原件；
 * 校验不过的整批在执行任何工具之前就被引擎拒掉、run 记 error）与其它中间件重建的 `resumeToolState.approvals`。
 * 被取消的项不在此列：引擎落"已取消"错误结果，onToolPhaseComplete 照旧补记结论
 */
function nativeResolutionsOf(config: ChatMiddlewareConfig): Map<string, NativeResolution> {
  const out = new Map<string, NativeResolution>()
  for (const [key, value] of config.resumeToolState?.approvals ?? []) {
    const r = nativeResolutionOf(value)
    if (r) out.set(key.startsWith(NATIVE_APPROVAL_PREFIX) ? key.slice(NATIVE_APPROVAL_PREFIX.length) : key, r)
  }
  for (const item of config.resume ?? []) {
    if (item.status !== "resolved" || !item.interruptId.startsWith(NATIVE_APPROVAL_PREFIX)) continue
    const r = nativeResolutionOf(item.payload)
    if (r) out.set(item.interruptId.slice(NATIVE_APPROVAL_PREFIX.length), r)
  }
  return out
}

/**
 * 引擎的"已取消"集合原件。公开类型是 ReadonlySet，0.53.0 实际交的是引擎自己的可变 Set（`buildMiddlewareConfig`），
 * 不是 Set 就当拿不到（客户端调用的拦截随之落到 toolPhaseComplete 的如实记录 + core.error）
 */
function engineCancelledOf(config: ChatMiddlewareConfig): Set<string> | undefined {
  const ids = config.resumeToolState?.cancelledToolCallIds
  return ids instanceof Set ? (ids as Set<string>) : undefined
}

/** 引擎落的"已取消"结果（0.53.0 `executeToolCalls` 查到 cancelledToolCallIds 时的固定形状）：调用没执行 */
function isEngineCancelled(r: { result?: unknown }): boolean {
  return (r.result as { error?: unknown } | undefined)?.error === "Tool execution cancelled"
}

/** 两份入参是否逐值相同（对象键序不计）：只用于判断审批人是否真的改了入参 */
function sameArgs(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical)
    if (typeof v === "object" && v !== null)
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
      )
    return v
  }
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

function defaultCapabilities(partial: ReinsMiddlewareOptions["capabilities"]): LoweringCapabilities {
  return {
    api: TANSTACK_API,
    midConversationSystem: false,
    thinkingReplay: true,
    parallelTools: true,
    taskBudget: false,
    images: true,
    maxOutputTokens: 8192,
    ...partial,
    // 恒 false，宿主传 true 也压回：TanStack 路径由 TanStack 的 adapter 决定工具怎么下发，本中间件没有 defer_loading /
    // tool_reference 的落点、也不读 `BeforeModelPatch.deferredTools`。放行 true 会让 lazyTools 走原生路径——
    // 工具表不改、名单被忽略，模型看见全表却在直调时被指去 tool_find。原生路径 = runLoop + lowering-fetch 的 Anthropic 线
    deferredTools: false,
  }
}

function lastBudgetUsage(timeline: readonly Event[]): CoreEventOf<"core.budget_usage"> | undefined {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]
    if (e?.type === "core.budget_usage") return e as CoreEventOf<"core.budget_usage">
  }
  return undefined
}

/** TanStack 用量（promptTokens 含缓存部分）→ reins 用量（input 不含缓存读写，Anthropic 口径） */
export function toReinsUsage(u: TanstackUsage): TokenUsage {
  const cacheRead = u.promptTokensDetails?.cachedTokens
  const cacheWrite = u.promptTokensDetails?.cacheWriteTokens
  const input = Math.max(0, u.promptTokens - (cacheRead ?? 0) - (cacheWrite ?? 0))
  return {
    input,
    output: u.completionTokens,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  }
}

/**
 * 造一个 reins 中间件。放在宿主其它中间件之后一般最合适：它改 providerMessages / tools / systemPrompts，
 * 后面的中间件看到的就是模型真正收到的。
 */
export function reinsMiddleware(options: ReinsMiddlewareOptions): ReinsChatMiddleware {
  const { sessionId, log, sockets = [] } = options
  // 窗口与预留在构造时校验（与 runLoop 起步、project() 同一函数）：capabilities 是静态的，拖到 buildTurn 的投影才抛，
  // tools_bound 与导入的用户消息已经落了日志，会话被判 interrupted（全库审查 2026-11-25 第二波返修）
  resolveReserveTokens({
    contextLimit: options.capabilities.contextWindow,
    ...(options.projection?.reserveTokens !== undefined
      ? { reserveTokens: options.projection.reserveTokens }
      : {}),
  })
  const registry = options.registry ?? createCoreRegistry()
  const now = options.now ?? (() => Date.now())
  const newId = options.newId ?? uuidv7
  const warn = options.warn ?? ((m: string) => console.warn(`[reins/adapter-tanstack-ai] ${m}`))
  /** 同一句只告一次（每个中间件实例）：宿主工具声明写错这类每个 run 都会再撞一遍的告警走这里 */
  const warned = new Set<string>()
  const warnOnce = (m: string) => {
    if (warned.has(m)) return
    warned.add(m)
    warn(m)
  }
  const emitCustom = options.emitCustomEvents ?? true
  const states = new WeakMap<ChatMiddlewareContext, RunState>()

  // ---- 基础动作：草稿 → 事件 → append。seq 只在这里分配（与 runLoop 同一约定） ----
  const append = async (
    ctx: ChatMiddlewareContext,
    s: RunState,
    drafts: readonly EventDraft[],
  ): Promise<Event[]> => {
    if (drafts.length === 0) return []
    const at = now()
    const events = drafts.map((d, i) =>
      createEvent(registry, { ...d, sessionId, seq: s.lastSeq + 1 + i, at, id: newId(at) }),
    )
    await log.append(events)
    s.lastSeq += events.length
    if (events.some((e) => e.type === "core.run_paused" || e.type === "core.run_ended")) s.ended = true
    // 本批登记（与 runLoop 同一口径）：模型输出的 tool_call 进 calls、落日志的 tool_result 进 results
    if (s.turn) {
      for (const e of events) {
        if (e.type === "core.tool_call") s.turn.batch.calls.push(e as ToolCallEvent)
        else if (e.type === "core.tool_result")
          s.turn.batch.results.push(e as CoreEventOf<"core.tool_result">)
      }
    }
    for (const e of events) {
      options.onEvent?.(e)
      if (emitCustom && !CONTENT_TYPES.has(e.type))
        ctx.emitCustomEvent(e.type, e as unknown as Record<string, unknown>)
    }
    return events
  }
  const flush = (ctx: ChatMiddlewareContext, s: RunState) => append(ctx, s, s.emitted.splice(0))
  /** 先落留痕（memory_op、approval_decision…），再落这条 —— 每条结果路径都走这里 */
  const settle = async (ctx: ChatMiddlewareContext, s: RunState, draft: EventDraft): Promise<Event[]> => [
    ...(await flush(ctx, s)),
    ...(await append(ctx, s, [draft])),
  ]
  const timelineOf = () => readTimeline(log, sessionId, { registry })

  const toolContextBase = (): Omit<ToolContext, "toolCallId" | "signal" | "emit"> => ({
    sessionId,
    log,
    ...(options.blobs ? { blobs: options.blobs } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.principal ? { principal: options.principal } : {}),
  })

  /** reins 工具表 → TanStack 工具表：视图换回宿主原件，脑子工具包一层（同名缓存，引用稳定） */
  const tanstackToolsOf = (s: RunState, tools: readonly Tool[]): AnyTool[] => {
    const out: AnyTool[] = []
    for (const t of tools) {
      if (isNativeToolView(t)) {
        const host = s.hostTools.get(t.name)
        if (host) out.push(host)
        continue
      }
      let w = s.wrapped.get(t.name)
      if (!w) {
        w = toTanstackTool(t, s.bridge)
        s.wrapped.set(t.name, w)
      }
      out.push(w)
    }
    return out
  }

  /**
   * 引擎在构造中间件上下文时就把 `chat({ interrupts })` 以 Capability 形式挂上（0.53.0 源码 `provideGenericInterruptDefinitionRegistry`），
   * 边界返回的中断按**引用同一性**校验（`definitions.get(id) !== definition` 即抛），这里用同一判据；拿不到登记表也当没登记
   */
  const approvalInterruptRegistered = (ctx: ChatMiddlewareContext): boolean =>
    ctx
      .getOptional(GenericInterruptDefinitionRegistryCapability)
      ?.definitions.get(REINS_APPROVAL_INTERRUPT_ID) === reinsApprovalInterrupt

  // ---- init：读日志、并入静态贡献、导入新输入 ----
  const initRun = async (ctx: ChatMiddlewareContext, config: ChatMiddlewareConfig): Promise<RunState> => {
    const model: ModelRef = { provider: ctx.provider, id: ctx.model }
    const capabilities = defaultCapabilities(options.capabilities)
    // 起步先把整条日志过一遍注册表：读不出来的事件在写任何东西之前拒绝（P9 fail-closed）
    const timeline = await timelineOf()
    const hostTools = new Map<string, AnyTool>()
    for (const t of config.tools) hostTools.set(t.name, t)
    const hostViews = config.tools.map((t) => viewOfTanstackTool(t, { warn: warnOnce }))
    const setupCfg = {
      log,
      model,
      tools: hostViews,
      sockets,
      ...(options.blobs ? { blobs: options.blobs } : {}),
      ...(options.memory ? { memory: options.memory } : {}),
      ...(options.principal ? { principal: options.principal } : {}),
    }
    // 宿主系统提示保持 TanStack 原来的条目（可能带 cache_control 之类元数据）不动，脑子的规则片段追加成最后一条；
    // 所以这里不把宿主提示交给 resolveSocketContributions，只取它算出的工具表与脑子片段
    const { tools: baseTools, systemPrompt: brainPrompt } = await resolveSocketContributions(setupCfg)
    const systemPrompts: SystemPrompt[] = [...config.systemPrompts]
    if (brainPrompt !== undefined) systemPrompts.push(brainPrompt)

    const s: RunState = {
      model,
      capabilities,
      registry,
      lastSeq: timeline.at(-1)?.seq ?? 0,
      startedAt: now(),
      turns: 0,
      tokensSpent: 0,
      toolCallsTotal: 0,
      hostTools,
      baseTools,
      systemPrompts,
      bridge: {
        sessionId,
        toolContextBase: toolContextBase(),
        emit: (d) => s.emitted.push(d),
        outputs: new Map(),
      },
      emitted: [],
      verdicts: new Map(),
      callEventIds: new Map(),
      assembler: new BlockAssembler({ provider: model.provider, api: TANSTACK_API, model: model.id }),
      wrapped: new Map(),
      lastTools: [],
      approvalInterruptRegistered: approvalInterruptRegistered(ctx),
      nativeResolutions: nativeResolutionsOf(config),
      editRefused: new Map(),
      callArgs: new Map(),
      cancelledByReins: new Set(),
      resumed: false,
      ended: false,
    }
    states.set(ctx, s)
    // 改参批准：只看原生卡上、仍在 pending 的调用；与日志入参逐值相同的不算改
    for (const call of pendingToolCalls(timeline)) {
      const r = s.nativeResolutions.get(call.payload.toolCallId)
      if (r?.editedArgs === undefined || !onNativeCard(s, call.payload.name)) continue
      if (!sameArgs(r.editedArgs, call.payload.args)) s.editRefused.set(call.payload.toolCallId, r.editedArgs)
    }
    // ToolContext.spend（§10.1 ④）：工具代跑的子代理用量计入本 run 的预算，budget 模块按总账拦
    s.bridge.toolContextBase.spend = (usage) => {
      s.tokensSpent += usage.input + usage.output
      if (s.turn) s.turn.ctx.budget.tokensSpent = s.tokensSpent
    }
    if (!s.approvalInterruptRegistered)
      warn(
        "reinsApprovalInterrupt is not registered with chat({ interrupts }), so this run cannot ask a human for approval: every tool call that needs approval is denied (fail-closed)",
      )

    // 工具表快照（P1）：与 runLoop 同一份纯函数。configHash 的系统提示只取脑子片段（宿主提示是 TanStack 的条目，
    // 可能带非文本元数据），所以与 runLoop 的 hash 不可比，只在本适配器内前后自比
    await append(
      ctx,
      s,
      toolsBoundDrafts({
        timeline,
        toolNames: baseTools.map((t) => t.name),
        configHash: await computeConfigHash({
          model,
          tools: baseTools,
          ...(brainPrompt !== undefined ? { systemPrompt: brainPrompt } : {}),
        }),
        announce: options.announceToolChanges ?? true,
      }),
    )

    // 新输入：日志为空则整段接管客户端历史，否则只取末尾新带来的用户消息（历史已在日志里）。
    // 幂等键按客户端完整数组里的位置（或消息自带 id）算，所以要告诉导入函数这一截从第几条起（R5）
    const origin = { provider: model.provider, api: TANSTACK_API, model: model.id }
    const fresh = timeline.length === 0 ? config.messages : trailingUserMessages(config.messages)
    if (fresh.length > 0) {
      const imported = importModelMessages(fresh, origin, {
        startIndex: config.messages.length - fresh.length,
      })
      if (imported.dropped.length > 0)
        warn(
          `some parts could not be translated while importing client messages: ${imported.dropped.join(", ")}`,
        )
      // 网络重试 / 客户端重放会把同一条用户消息再发一遍：日志里已有同键同内容的就跳过，不让它入日志两次
      const { drafts, skipped } = dedupeImportedUserMessages(imported.drafts, timeline)
      if (skipped > 0)
        warn(
          `the client re-sent ${skipped} user message(s) already in the log (a network retry?); they were skipped`,
        )
      await append(ctx, s, drafts)
    }
    return s
  }

  /** 造本轮 TurnContext（投影已算好）。续跑补齐 pending 调用时没有 beforeModel，也要有它给 beforeTool 用 */
  const buildTurn = async (
    ctx: ChatMiddlewareContext,
    s: RunState,
    timeline: Event[],
  ): Promise<TurnState> => {
    const turnStartedAt = now()
    const projected = project({
      timeline,
      budget: {
        contextLimit: s.capabilities.contextWindow,
        ...(options.projection?.reserveTokens !== undefined
          ? { reserveTokens: options.projection.reserveTokens }
          : {}),
      },
      registry,
      sessionId,
      now: turnStartedAt,
      newId,
      ...(options.projection?.strategies ? { strategies: options.projection.strategies } : {}),
      ...(options.projection?.estimate ? { estimate: options.projection.estimate } : {}),
    })
    if (projected.emitted.length > 0) {
      // 阈值兜底折叠等策略新造的事件先入日志：模型可见 ⟺ 已记录
      await log.append(projected.emitted)
      s.lastSeq += projected.emitted.length
      for (const e of projected.emitted) {
        options.onEvent?.(e)
        if (emitCustom) ctx.emitCustomEvent(e.type, e as unknown as Record<string, unknown>)
      }
    }
    const lastUsage = lastBudgetUsage(timeline)?.payload.tokens
    const batch: TurnState["batch"] = { calls: [], results: [], held: [], resumed: false }
    const turnCtx: TurnContext = {
      session: { id: sessionId, turn: s.turns },
      ...(options.principal ? { principal: options.principal } : {}),
      events: projected.events,
      timeline,
      log,
      ...(options.blobs ? { blobs: options.blobs } : {}),
      ...(options.memory ? { memory: options.memory } : {}),
      tools: s.baseTools,
      model: s.model,
      capabilities: s.capabilities,
      budget: {
        contextLimit: s.capabilities.contextWindow,
        targetTokens: projected.stats.targetTokens,
        used: projected.stats.estimatedTokens,
        tokensSpent: s.tokensSpent,
        turns: s.turns,
        toolCalls: s.toolCallsTotal,
        wallMs: turnStartedAt - s.startedAt,
        ...(lastUsage ? { lastUsage } : {}),
      },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      batch,
      emit: (d) => s.emitted.push(d),
    }
    return {
      ctx: turnCtx,
      batch,
      estimate: projected.stats.estimatedTokens,
      startedAt: turnStartedAt,
      toolCalls: 0,
      modelEvents: [],
    }
  }

  /**
   * 跟上引擎自己换过的宿主工具表（全库审查 2026-11-25 #33）。TanStack 原生 lazy 工具在工具阶段被发现后，引擎把活动表
   * 换成 `lazyToolManager.getActiveTools()`（新发现的工具进表、全部发现后撤下发现工具）；本中间件每轮又按起步快照
   * 交回工具表，不跟上就会把刚发现的工具盖掉——模型看不见，照发现结果去调还撞 "Unknown tool"。
   *
   * 判据：这一轮引擎给的表与上一次交给它的不同（逐个同一性），才认为是引擎换过。只增不删：新出现的宿主工具（不是本
   * 中间件包装的脑子工具）补进视图，排在宿主视图之后、脑子工具之前；删只认引擎撤下的发现工具——排在本中间件之后的宿主
   * 中间件按轮过滤掉的工具也会表现为"不在表里"，照删就再也回不来。与已有工具同名的不收（先到者赢，与
   * resolveSocketContributions 同口径），告警一次。工具表在 run 内变化不另记 tools_bound，下一个 run 起步照常比对
   */
  const syncHostTools = (s: RunState, engineTools: readonly AnyTool[]) => {
    if (engineTools.length === s.lastTools.length && engineTools.every((t, i) => t === s.lastTools[i])) return
    const wrapped = new Set(s.wrapped.values())
    const taken = new Set(s.baseTools.map((t) => t.name))
    const added: Tool[] = []
    for (const t of engineTools) {
      if (wrapped.has(t) || s.hostTools.get(t.name) === t) continue
      if (taken.has(t.name)) {
        warnOnce(
          `host tool ${t.name} appeared during the run but a tool with that name is already bound; it was not added`,
        )
        continue
      }
      s.hostTools.set(t.name, t)
      added.push(viewOfTanstackTool(t, { warn: warnOnce }))
      taken.add(t.name)
    }
    const dropDiscovery =
      s.hostTools.has(DISCOVERY_TOOL_NAME) && !engineTools.some((t) => t.name === DISCOVERY_TOOL_NAME)
    if (added.length === 0 && !dropDiscovery) return
    if (dropDiscovery) s.hostTools.delete(DISCOVERY_TOOL_NAME)
    const kept = dropDiscovery
      ? s.baseTools.filter((t) => !(isNativeToolView(t) && t.name === DISCOVERY_TOOL_NAME))
      : s.baseTools
    let at = 0
    kept.forEach((t, i) => {
      if (isNativeToolView(t)) at = i + 1
    })
    s.baseTools = [...kept.slice(0, at), ...added, ...kept.slice(at)]
  }

  // ---- beforeModel：投影 + Socket 补丁 → providerMessages / tools / systemPrompts ----
  const beforeModel = async (
    ctx: ChatMiddlewareContext,
    s: RunState,
    config: ChatMiddlewareConfig,
  ): Promise<Partial<ChatMiddlewareConfig>> => {
    syncHostTools(s, config.tools)
    const timeline = await timelineOf()
    s.turns++
    const turn = await buildTurn(ctx, s, timeline)
    const tctx = turn.ctx
    let visible = tctx.events
    let tools = s.baseTools
    let systemPrompt: string | undefined
    for (const sock of sockets) {
      const patch = await sock.beforeModel?.(tctx)
      if (!patch) continue
      if (patch.events) visible = patch.events
      if (patch.tools) tools = patch.tools
      if (patch.systemPrompt !== undefined) systemPrompt = patch.systemPrompt
      tctx.events = visible
      tctx.tools = tools
    }
    const injected = await flush(ctx, s)
    // 运维类型与 ext.* 不进本轮视图：与 runLoop、投影同一口径（core isModelInvisibleByDefault）
    visible = [...visible, ...injected.filter((e) => !isModelInvisibleByDefault(e.type))]
    tctx.events = visible
    tctx.tools = tools
    // 与 runLoop 同口径：contextEstimate 取真正送出的视图，注入的说明 / 快照不被当成固定开销重复计（全库审查 2026-11-25 #20）
    turn.estimate = estimateTotal(visible, options.projection?.estimate ?? roughTokenEstimate)
    s.turn = turn
    s.assembler.reset()

    const { messages, landings } = toModelMessages(visible, {
      model: s.model,
      ...(options.trustMarkers !== undefined ? { trustMarkers: options.trustMarkers } : {}),
    })
    options.onLandings?.(landings.filter((l) => l.kind !== "exact"))
    s.lastTools = tanstackToolsOf(s, tools)
    return {
      providerMessages: messages,
      tools: s.lastTools,
      systemPrompts: systemPrompt !== undefined ? [systemPrompt] : s.systemPrompts,
    }
  }

  /**
   * 本 run 第一次写答复时先落一条 run_resumed（通用中断与原生审批共用），**排在结论之前**、带第一条结论的 `by`，
   * 与 runLoop 同序同形（run-loop.ts 续跑段）。调用方在 flush 结论草稿之前调
   */
  const markResumed = async (ctx: ChatMiddlewareContext, s: RunState, by: string | undefined) => {
    if (s.resumed) return
    s.resumed = true
    await append(ctx, s, [
      { type: "core.run_resumed", actor: "host", payload: by !== undefined ? { by } : {} },
    ])
  }
  /**
   * 对一个调用按当前时间线重跑 beforeTool 管线，只看有没有 Socket 要拦（block）；rewrite 按顺序传给后面的 Socket，
   * defer 略过（调用已批准）。Socket 经 emit 留的痕（如 approval 的过期拒绝结论）随即落日志。返回拦截说明或 undefined
   */
  const rerunForBlock = async (
    ctx: ChatMiddlewareContext,
    s: RunState,
    toolCallId: string,
    tool: Tool | undefined,
  ): Promise<string | undefined> => {
    const timeline = await timelineOf()
    const call = pendingToolCalls(timeline).find((c) => c.payload.toolCallId === toolCallId)
    if (!call || !s.turn) return undefined
    const tctx = s.turn.ctx
    tctx.timeline = timeline
    let seen: ToolCallEvent = call
    let refused: string | undefined
    for (const sock of sockets) {
      const d = await sock.beforeTool?.(tctx, seen, tool)
      if (d === undefined || d === "proceed") continue
      if ("rewrite" in d) {
        seen = { ...seen, payload: { ...seen.payload, args: d.rewrite } }
        continue
      }
      if ("block" in d) {
        refused = d.block
        break
      }
    }
    await flush(ctx, s)
    return refused
  }
  /**
   * 放行时的结论。原生卡上的调用（宿主工具静态 needsApproval: true）被 Socket rewrite 过就拦下（第二轮返修 N2）：
   * 原生卡展示的是模型原入参，照改写后的执行就是"审批人批 A、实际执行 B"；改走 reins 卡又会让同一调用再出原生卡（#4）。
   * 引擎只在批准后才对这类调用调 onBeforeToolCall，所以人仍会被问一次，批了也不执行；拒了照常落拒绝
   */
  const passVerdict = (s: RunState, name: string, rewritten: boolean, args: unknown): Verdict => {
    if (!rewritten) return { kind: "proceed" }
    if (onNativeCard(s, name))
      return {
        kind: "block",
        text: "the arguments were rewritten by a socket, but TanStack's native approval card shows the arguments the model wrote, so the call was not executed",
      }
    return { kind: "rewrite", args }
  }
  /** 宿主工具自带静态 needsApproval: true：它的审批只走 TanStack 原生卡，reins 卡从不为它发 */
  const onNativeCard = (s: RunState, name: string): boolean => s.hostTools.get(name)?.needsApproval === true
  /**
   * 客户端工具：没有 execute、由引擎交给前端执行、不经 onBeforeToolCall 的——宿主给的 TanStack 工具，或 Socket 贡献的
   * reins 客户端工具（包装后同样没有 execute）。只认宿主工具会让 Socket 的 block / approval 拒绝 / needsApproval 抛错
   * 拦不住后者：引擎照常交给前端执行（发版前终审 B 复查）
   */
  const isClientTool = (s: RunState, name: string): boolean => {
    const t = s.hostTools.get(name) ?? s.wrapped.get(name)
    return t !== undefined && typeof t.execute !== "function"
  }

  /**
   * 原生审批的答复记成 approval_decision（全库审查 2026-11-25 #5）。在 beforeTools 边界、Socket 管线之前落：
   * 审批 ttl 等按"批准事件"判的规则要看得见它（#4 起 Socket 的 defer 也可能由原生那张卡答复）。
   * 只给**正在等审批**的调用记（有 approval_request、还没有结论，与 runLoop 同一口径 `awaitingOf`）。
   *
   * 审批人改了入参（`editedArgs` 与日志里的 tool_call 入参不同）时不执行：本库的时间线没有"改参批准"的落点，
   * tool_call 是模型的原话、只追加不改，照改过的入参执行就是"日志写 staging、实际改了 prod"（宪法二）。
   * 批准照记，再由 reins 补一条拒绝结论说明原因；拒绝结论在后，beforeTools 按最后一条结论拦下，模型从结果里看到
   * 审批人想要的入参，可以按它重新发起（会再问一次人）。真正挡住执行的是 init 交给引擎的"已取消"（`s.editRefused`）：
   * 客户端工具不经 onBeforeToolCall，光靠这里的结论拦不住（第二波返修 B1）
   */
  const recordNativeResolutions = async (
    ctx: ChatMiddlewareContext,
    s: RunState,
    timeline: readonly Event[],
  ): Promise<boolean> => {
    if (s.nativeResolutions.size === 0) return false
    const resolutions = s.nativeResolutions
    s.nativeResolutions = new Map()
    const pending = pendingToolCalls(timeline)
    const awaiting = new Set(
      awaitingOf({ timeline, pending, tools: [], interruptions: [] })
        .filter((a) => a.kind === "approval")
        .map((a) => a.toolCallId),
    )
    const drafts: EventDraft[] = []
    for (const call of pending) {
      const { toolCallId, name } = call.payload
      const r = resolutions.get(toolCallId)
      // 只认原生卡上的调用：`approval_<id>` 只能答原生卡，答不了 reins 卡（引擎也会以 unknown-interrupt 拒掉整批）
      if (!r || !awaiting.has(toolCallId) || !onNativeCard(s, name)) continue
      drafts.push({
        type: "core.approval_decision",
        actor: "host",
        parentId: call.id,
        payload: { toolCallId, approved: r.approved, by: TANSTACK_DECIDER },
      })
      const edited = s.editRefused.get(toolCallId)
      if (edited !== undefined) {
        drafts.push({
          type: "core.approval_decision",
          actor: "system",
          parentId: call.id,
          payload: {
            toolCallId,
            approved: false,
            by: "reins",
            reason: `the approver edited the arguments to ${JSON.stringify(edited)}; edited arguments cannot be recorded in the timeline, so the call was not executed. Make the call again with the arguments you intend to use`,
          },
        })
      }
    }
    if (drafts.length === 0) return false
    await markResumed(ctx, s, TANSTACK_DECIDER)
    await append(ctx, s, drafts)
    return true
  }

  // ---- beforeTools 边界：对每个待执行调用跑 beforeTool 管线，结论缓存；defer → 通用中断 ----
  const beforeTools = async (ctx: ChatMiddlewareContext, s: RunState) => {
    let timeline = await timelineOf()
    if (await recordNativeResolutions(ctx, s, timeline)) timeline = await timelineOf()
    const pending = pendingToolCalls(timeline)
    if (pending.length === 0) return undefined
    if (!s.turn) {
      // 续跑补齐：还没问过模型。本批 = 遗留调用所在那批（含上次已落的结果），与 runLoop 同一个 toolBatchOf
      s.turn = await buildTurn(ctx, s, timeline)
      const located = toolBatchOf(timeline, pending)
      s.turn.batch.calls.push(...located.calls)
      s.turn.batch.results.push(...located.results)
      s.turn.batch.resumed = true
    }
    const tctx = s.turn.ctx
    const decisions = new Map<string, CoreEventOf<"core.approval_decision">["payload"]>()
    const requested = new Set<string>()
    for (const raw of timeline) {
      const e = raw as CoreEvent
      if (e.type === "core.approval_decision") decisions.set(e.payload.toolCallId, e.payload)
      if (e.type === "core.approval_request") requested.add(e.payload.toolCallId)
    }

    const started = toolStartedAt(timeline)
    const interrupts: ReturnType<ReinsApprovalInterrupt["interrupt"]>[] = []
    for (const call of pending) {
      const { toolCallId, name } = call.payload
      s.callEventIds.set(toolCallId, call.id)
      s.callArgs.set(toolCallId, call.payload.args)
      const tool = tctx.tools.find((t) => t.name === name)
      // 中断不重放（与 runLoop 同一判据）：工具不在表里按不可重放处理
      if (started.has(toolCallId) && (tool === undefined || !isReplayable(tool))) {
        s.verdicts.set(toolCallId, {
          kind: "unknown",
          text: outcomeUnknownText(tool, started.get(toolCallId)),
        })
        continue
      }
      const decided = decisions.get(toolCallId)
      if (decided && !decided.approved) {
        s.verdicts.set(toolCallId, {
          kind: "block",
          text: `Approval denied${decided.reason ? `: ${decided.reason}` : ""}`,
        })
        continue
      }
      // 与 runLoop 同一规则：任一 block / defer 即定；rewrite 替换入参后继续问；已批准的调用遇到 defer 只是略过
      let args: unknown = call.payload.args
      let rewritten = false
      let seen: ToolCallEvent = call
      let verdict: BeforeToolDecision = "proceed"
      for (const sock of sockets) {
        const d = await sock.beforeTool?.(tctx, seen, tool)
        if (d === undefined || d === "proceed") continue
        if ("rewrite" in d) {
          args = d.rewrite
          rewritten = true
          seen = { ...seen, payload: { ...seen.payload, args } }
          continue
        }
        if ("defer" in d && decided?.approved) continue
        verdict = d
        break
      }
      if (typeof verdict === "object" && "block" in verdict) {
        s.verdicts.set(toolCallId, { kind: "block", text: verdict.block })
        continue
      }
      let approval = typeof verdict === "object" && "defer" in verdict ? verdict.defer : undefined
      // 工具自己声明 needsApproval：TanStack 宿主工具由 TanStack 原生审批处理；reins 工具在这里按 runLoop 兜底。
      // 入参先过 validate（R1，与 runLoop 同序）：needsApproval 与摘要看到的是将要执行的那份；校验不过就不问人，
      // 执行时 toTanstackTool 会以"Invalid arguments"报错
      if (
        !approval &&
        !decided?.approved &&
        tool &&
        !isNativeToolView(tool) &&
        tool.needsApproval !== undefined
      ) {
        let input: unknown = args
        let valid = true
        try {
          if (tool.validate) input = tool.validate(args)
        } catch {
          valid = false
        }
        if (valid) {
          let need: boolean
          try {
            need =
              typeof tool.needsApproval === "function"
                ? await tool.needsApproval(input, {
                    ...toolContextBase(),
                    toolCallId,
                    emit: (d) => s.emitted.push(d),
                  })
                : tool.needsApproval
          } catch (err) {
            // 与 runLoop 同口径：判不出要不要审批就当拒绝（fail-closed），不执行、模型看到一句说明；宿主那份记在模型不可见的
            // core.error(host)。不收口的话异常直接抛给宿主、tool_call 悬空，下一个请求也补不齐（发版前终审）
            s.emitted.push({
              type: "core.error",
              actor: "system",
              payload: {
                category: "host",
                message: `needsApproval of ${name} threw: ${errorMessageOf(err)}`,
                retryable: false,
                detail: { phase: "needsApproval", toolCallId },
              },
            })
            s.verdicts.set(toolCallId, {
              kind: "unknown",
              text: `Approval check failed: ${errorMessageOf(err)}`,
            })
            continue
          }
          if (need)
            approval = {
              policyId: BUILTIN_APPROVAL_POLICY,
              summary: `${name}(${JSON.stringify(input) ?? ""})`,
            }
        }
      }
      if (approval && !decided?.approved) {
        // 宿主工具自带静态 needsApproval：TanStack 执行阶段会自己开原生审批卡。Socket 的 defer 不再另发 reins 中断——
        // 同一调用两张卡，只答一张引擎就拒绝续跑，答两张审批人被问两遍（全库审查 2026-11-25 #4）。
        // 请求按 Socket 的策略与摘要入日志（toolPhaseComplete 见已有请求不重记），问人交给原生那张卡
        if (tool && isNativeToolView(tool) && tool.needsApproval === true) {
          if (!requested.has(toolCallId)) {
            s.emitted.push({
              type: "core.approval_request",
              actor: "system",
              parentId: call.id,
              payload: { toolCallId, policyId: approval.policyId, summary: approval.summary },
            })
          }
          s.verdicts.set(toolCallId, passVerdict(s, name, rewritten, args))
          continue
        }
        if (!requested.has(toolCallId)) {
          s.emitted.push({
            type: "core.approval_request",
            actor: "system",
            parentId: call.id,
            payload: { toolCallId, policyId: approval.policyId, summary: approval.summary },
          })
        }
        // 审批中断没登记就问不了人（R7）：留一条 approval_decision(false) 再拦截，审计上"想问、问不了、按拒绝"三步都在日志里；
        // 模型看到的是错误结果，而不是引擎抛错把 run 打死在一条等不到答复的 run_paused 上
        if (!s.approvalInterruptRegistered) {
          const reason =
            "the approval interrupt is not registered (chat({ interrupts }) lacks reinsApprovalInterrupt), so approval cannot be requested and the call is denied"
          s.emitted.push({
            type: "core.approval_decision",
            actor: "system",
            parentId: call.id,
            payload: { toolCallId, approved: false, by: "reins", reason },
          })
          s.verdicts.set(toolCallId, { kind: "block", text: `Approval denied: ${reason}` })
          continue
        }
        interrupts.push(
          reinsApprovalInterrupt.interrupt({
            key: toolCallId,
            reason: "tool_call",
            message: approval.summary,
            payload: { toolCallId, name, args, policyId: approval.policyId, summary: approval.summary },
          }),
        )
        s.verdicts.set(toolCallId, { kind: "await" })
        continue
      }
      s.verdicts.set(toolCallId, passVerdict(s, name, rewritten, args))
    }
    // 客户端工具判了拦下（含 approval deny、原生卡上被改写、结果未知）：服务端工具在 onBeforeToolCall 拦，客户端工具
    // 不经那个钩子，只能交给引擎当"已取消"——引擎先查取消再分客户端 / 审批，前端拿不到这次调用（第三轮返修 B）
    for (const call of pending) {
      const { toolCallId, name } = call.payload
      const kind = s.verdicts.get(toolCallId)?.kind
      if ((kind === "block" || kind === "unknown") && isClientTool(s, name) && s.engineCancelled) {
        s.engineCancelled.add(toolCallId)
        s.cancelledByReins.add(toolCallId)
      }
    }
    await flush(ctx, s)
    if (interrupts.length === 0) return undefined
    await append(ctx, s, [{ type: "core.run_paused", actor: "system", payload: { reason: "approval" } }])
    return { interrupts }
  }

  // ---- 结果入日志（onAfterToolCall 与 onToolPhaseComplete 共用） ----
  const resultDraft = (
    call: ToolCallEvent | undefined,
    toolCallId: string,
    name: string,
    result: ToolResult,
    tool?: Tool,
  ): ToolResultDraft => ({
    type: "core.tool_result",
    actor: "tool",
    ...(call ? { parentId: call.id } : {}),
    provenance: { source: name },
    // 与 runLoop 同一口径（core 同一个纯函数）：工具声明的 resultTrust 只用于成功结果（拦截 / 失败仍是缺省 untrusted）
    ...(() => {
      const trust = toolResultTrust(tool, result.isError ?? false)
      return trust === undefined ? {} : { trust }
    })(),
    payload: { toolCallId, name, content: result.content, isError: result.isError ?? false },
  })
  const errorResult = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true })
  /** 本轮工具表里（beforeModel 补丁后的），没有轮上下文就查 run 起步的基表 */
  const toolNamed = (s: RunState, name: string): Tool | undefined =>
    (s.turn?.ctx.tools ?? s.baseTools).find((t) => t.name === name)

  const afterTool = async (ctx: ChatMiddlewareContext, s: RunState, info: AfterToolCallInfo) => {
    const timeline = await timelineOf()
    const answered = timeline.some(
      (e) =>
        e.type === "core.tool_result" &&
        (e as CoreEventOf<"core.tool_result">).payload.toolCallId === info.toolCallId,
    )
    if (answered) return
    const call = pendingToolCalls(timeline).find((c) => c.payload.toolCallId === info.toolCallId)
    const verdict = s.verdicts.get(info.toolCallId)
    const stored = s.bridge.outputs.get(info.toolCallId)
    s.bridge.outputs.delete(info.toolCallId)

    if (verdict?.kind === "block" || verdict?.kind === "unknown") {
      // 拦截：不经 afterTool，留痕（如 approval_decision）先落
      const text = verdict.kind === "block" ? `Tool call blocked: ${verdict.text}` : verdict.text
      await settle(ctx, s, resultDraft(call, info.toolCallId, info.toolName, errorResult(text)))
      return
    }
    let result: ToolResult
    if (stored) result = stored
    else if (info.ok) result = { content: fromTanstackToolResult(info.result), isError: false }
    else result = errorResult(`Tool execution failed: ${errorMessageOf(info.error)}`)
    s.toolCallsTotal++
    if (s.turn) s.turn.ctx.budget.toolCalls = s.toolCallsTotal

    let draft = resultDraft(call, info.toolCallId, info.toolName, result, toolNamed(s, info.toolName))
    if (s.turn && call) {
      for (const sock of sockets) {
        const replaced = await sock.afterTool?.(s.turn.ctx, call, draft)
        if (replaced) draft = replaced
      }
    }
    // 这条路径不做图片引用的归属校验，也不换回：落日志前一律换成占位文本（2026-11-24 独立审查）。
    // 否则 reins 工具或 afterTool 返回的别的会话的 blobId 会原样进日志，之后被 mediaRefsOf 当成"本会话引用过"放行
    draft = { ...draft, payload: { ...draft.payload, content: withoutImageRefs(draft.payload.content) } }
    await settle(ctx, s, draft)
  }

  const toolPhaseComplete = async (ctx: ChatMiddlewareContext, s: RunState, info: ToolPhaseCompleteInfo) => {
    const timeline = await timelineOf()
    const answered = new Set<string>()
    const requested = new Set<string>()
    const decided = new Set<string>()
    /** 引擎自己按原生审批拒绝的调用（最后一条 tanstack 结论是拒绝）：引擎落拒绝结果、没执行 */
    const nativeDenied = new Set<string>()
    for (const raw of timeline) {
      const e = raw as CoreEvent
      if (e.type === "core.tool_result") answered.add(e.payload.toolCallId)
      if (e.type === "core.approval_request") requested.add(e.payload.toolCallId)
      if (e.type === "core.approval_decision") {
        decided.add(e.payload.toolCallId)
        if (e.payload.by === TANSTACK_DECIDER && !e.payload.approved) nativeDenied.add(e.payload.toolCallId)
        else if (e.payload.by === TANSTACK_DECIDER) nativeDenied.delete(e.payload.toolCallId)
      }
    }
    const pending = pendingToolCalls(timeline)
    // TanStack 自己处理掉、没走 onAfterToolCall 的结果：原生审批拒绝、未知工具、入参解析失败、客户端回填、取消
    for (const r of info.results) {
      if (answered.has(r.toolCallId)) continue
      const call = pending.find((c) => c.payload.toolCallId === r.toolCallId)
      const isError = (r as { state?: string }).state === "output-error"
      if (requested.has(r.toolCallId) && !decided.has(r.toolCallId)) {
        // 原生审批被拒：TanStack 不告诉我们是谁拒的，只知道结果是拒绝
        s.emitted.push({
          type: "core.approval_decision",
          actor: "host",
          payload: { toolCallId: r.toolCallId, approved: !isError, by: TANSTACK_DECIDER },
        })
      }
      const verdict = s.verdicts.get(r.toolCallId)
      const blocked = verdict?.kind === "block" || verdict?.kind === "unknown"
      // 拦截真落实了才写拦截说明：交给引擎取消的（客户端调用、改参批准）或引擎自己按原生审批拒的，以及不在客户端
      // 执行的（服务端工具在 onBeforeToolCall 拦）。客户端工具没拦住、前端真执行了：照实记结果，宪法二不许改写
      const enforced =
        !isClientTool(s, r.toolName) ||
        ((s.cancelledByReins.has(r.toolCallId) || s.editRefused.has(r.toolCallId)) && isEngineCancelled(r)) ||
        nativeDenied.has(r.toolCallId)
      const result: ToolResult =
        blocked && enforced
          ? errorResult(verdict.kind === "block" ? `Tool call blocked: ${verdict.text}` : verdict.text)
          : { content: fromTanstackToolResult(r.result), isError }
      await settle(ctx, s, resultDraft(call, r.toolCallId, r.toolName, result, toolNamed(s, r.toolName)))
      if (blocked && !enforced) {
        // 模型不可见：模型看到的是真实结果；给宿主与审计留一条"判了拦下却没拦住"
        await append(ctx, s, [
          {
            type: "core.error",
            actor: "system",
            payload: {
              category: TANSTACK_API,
              message: `A socket blocked client tool call ${r.toolCallId} (${r.toolName}), but the block was not enforced: TanStack handed the call to the client, which ran it. The real result is recorded`,
              retryable: false,
              detail: { toolCallId: r.toolCallId, name: r.toolName, verdict: verdict.text },
            },
          },
        ])
      }
      answered.add(r.toolCallId)
    }
    // 原生审批请求：入日志，与 reins 审批同一事件形状
    for (const a of info.needsApproval) {
      if (requested.has(a.toolCallId)) continue
      const call = pending.find((c) => c.payload.toolCallId === a.toolCallId)
      s.emitted.push({
        type: "core.approval_request",
        actor: "system",
        ...(call ? { parentId: call.id } : {}),
        payload: {
          toolCallId: a.toolCallId,
          policyId: TANSTACK_APPROVAL_POLICY,
          summary: `${a.toolName}(${JSON.stringify(a.input) ?? ""})`,
        },
      })
    }
    await flush(ctx, s)
    if (info.needsApproval.length > 0)
      await append(ctx, s, [{ type: "core.run_paused", actor: "system", payload: { reason: "approval" } }])
    else if (info.needsClientExecution.length > 0)
      await append(ctx, s, [{ type: "core.run_paused", actor: "system", payload: { reason: "host" } }])
  }

  // ---- 交接：与 runLoop 同一机械（旧会话记 handoff，新会话开头 = 摘要 + 开场 + 触发消息） ----
  const doHandoff = async (ctx: ChatMiddlewareContext, s: RunState, intent: HandoffIntent) => {
    const toSessionId = intent.toSessionId ?? newId(now())
    const [handoffEvent] = await append(ctx, s, [
      {
        type: "core.handoff",
        actor: intent.by ?? "model",
        payload: {
          toSessionId,
          summary: intent.summary,
          reason: intent.reason,
          ...(intent.triggerMessage !== undefined ? { triggerMessage: intent.triggerMessage } : {}),
        },
      },
    ])
    const at = now()
    // 发起者如实记：与 runLoop 调同一个 handoffOpeningDrafts，触发消息对照旧会话完整时间线判是不是用户原话
    const opening = handoffOpeningDrafts(intent, handoffEvent as Event, await timelineOf())
    const events = opening.map((d, i) =>
      createEvent(registry, { ...d, sessionId: toSessionId, seq: i + 1, at, id: newId(at) }),
    )
    // 与 runLoop 同口径：新会话开场只写日志、不交给本 run 的 onEvent（宿主拿它推旧会话的前端会多出别的会话的消息）
    await log.append(events)
    // 新会话开场写成之后立即在旧会话落终结记号（与 runLoop 同序）。不能留给 onFinish：交接后连接被取消时引擎跳过 onFinish、
    // 改调 onAbort，旧会话就会被记成 paused(host)
    await append(ctx, s, [
      { type: "core.run_ended", actor: "system", payload: { status: "handoff", toSessionId } },
    ])
    await options.onHandoff?.(sessionId, toSessionId)
  }

  const middleware: ReinsChatMiddleware = {
    name: "reins",

    async onConfig(ctx, config) {
      if (ctx.phase === "init") {
        const s = await initRun(ctx, config)
        const cancelled = engineCancelledOf(config)
        if (cancelled) s.engineCancelled = cancelled
        s.lastTools = tanstackToolsOf(s, s.baseTools)
        if (s.editRefused.size === 0) return { tools: s.lastTools, systemPrompts: s.systemPrompts }
        // 改参批准的调用交给引擎当"已取消"：引擎在 init 之后才应用答复，取消先于审批判定，改过的入参到不了执行
        // （服务端工具不调 onBeforeToolCall 之外，客户端工具连 onBeforeToolCall 都不经过，只能在这里拦，B1）
        return {
          tools: s.lastTools,
          systemPrompts: s.systemPrompts,
          resumeToolState: {
            ...config.resumeToolState,
            cancelledToolCallIds: new Set([
              ...(config.resumeToolState?.cancelledToolCallIds ?? []),
              ...s.editRefused.keys(),
            ]),
          },
        }
      }
      const s = states.get(ctx)
      if (!s) return undefined
      const cancelled = engineCancelledOf(config)
      if (cancelled) s.engineCancelled = cancelled
      if (ctx.phase === "beforeModel" || ctx.phase === "structuredOutput") return beforeModel(ctx, s, config)
      return undefined
    },

    async onChunk(ctx, chunk: StreamChunk) {
      const s = states.get(ctx)
      if (!s || !(ctx.phase === "modelStream" || ctx.phase === "structuredOutput")) return undefined
      const drafts = s.assembler.push(chunk)
      if (drafts.length === 0) return undefined
      const events = await append(ctx, s, drafts)
      if (s.turn) {
        s.turn.modelEvents.push(...events)
        s.turn.toolCalls += events.filter((e) => e.type === "core.tool_call").length
      }
      return undefined
    },

    async onUsage(ctx, usage) {
      const s = states.get(ctx)
      if (!s?.turn) return
      const tokens = toReinsUsage(usage)
      s.tokensSpent += tokens.input + tokens.output
      const b = s.turn.ctx.budget
      b.tokensSpent = s.tokensSpent
      b.wallMs = now() - s.startedAt
      b.lastUsage = tokens
      await append(ctx, s, [
        {
          type: "core.budget_usage",
          actor: "system",
          payload: {
            tokens,
            toolCalls: s.turn.toolCalls,
            wallMs: now() - s.turn.startedAt,
            contextEstimate: s.turn.estimate,
          },
        },
      ])
    },

    async onInterruptBoundary(ctx) {
      const s = states.get(ctx)
      if (!s) return undefined
      if (ctx.phase === "afterModel") {
        if (s.turn) {
          const leftover = await append(ctx, s, s.assembler.finish())
          s.turn.modelEvents.push(...leftover)
          for (const sock of sockets) await sock.afterModel?.(s.turn.ctx, s.turn.modelEvents)
          await flush(ctx, s)
        }
        return undefined
      }
      if (ctx.phase === "beforeTools") return beforeTools(ctx, s)
      return undefined
    },

    async onInterruptResolution(ctx, resolutions) {
      const s = states.get(ctx)
      if (!s) return undefined
      // 通用中断的续跑不签名：key 与答复全由客户端的 resume 带来，照抄合法项改个 key 引擎就接受（全库审查 2026-11-25 #35）。
      // 只收指向本会话**正在等审批**的调用的答复（有 approval_request、还没有结论、同一调用只收一条），与 runLoop / server
      // 同一个 assertDecisionsAwaitApproval；其余不入日志、告警。否则不对应任何请求的结论会进日志，还能替模型将来才发出的
      // 调用预先批准、绕过审批
      // 原生卡上的调用（宿主工具自带静态 needsApproval: true）从不发 reins 卡，它的通用答复一律是伪造的：收下就会替它写
      // 批准，原生答复的改参核对随之被跳过（第二波返修 B1）
      const timeline = await timelineOf()
      const pending = pendingToolCalls(timeline)
      const accepted: ApprovalDecisionInput[] = []
      const drafts: EventDraft[] = []
      for (const r of resolutions.for(reinsApprovalInterrupt)) {
        const approved = r.status === "resolved" && r.response.approved === true
        const by = r.status === "resolved" && r.response.by ? r.response.by : TANSTACK_DECIDER
        const reason = r.status === "resolved" ? r.response.reason : "Approval was cancelled"
        const decision: ApprovalDecisionInput = {
          toolCallId: r.request.key,
          approved,
          by,
          ...(reason !== undefined ? { reason } : {}),
        }
        try {
          assertDecisionsAwaitApproval({ sessionId, timeline, decisions: [...accepted, decision] })
        } catch (err) {
          if (!(err instanceof RunStateError)) throw err
          warn(`ignored an approval answer from the client: ${err.message}`)
          continue
        }
        const call = pending.find((c) => c.payload.toolCallId === decision.toolCallId)
        if (call && onNativeCard(s, call.payload.name)) {
          warn(
            `ignored an approval answer from the client: call ${decision.toolCallId} is approved through TanStack's native approval, never through reinsApprovalInterrupt`,
          )
          continue
        }
        accepted.push(decision)
        drafts.push({
          type: "core.approval_decision",
          actor: "host",
          ...(call ? { parentId: call.id } : {}),
          payload: decision,
        })
      }
      if (drafts.length > 0) {
        await markResumed(ctx, s, accepted[0]?.by)
        await append(ctx, s, drafts)
      }
      return { toolResume: "continue" }
    },

    async onBeforeToolCall(ctx, hookCtx) {
      const s = states.get(ctx)
      const v = s?.verdicts.get(hookCtx.toolCallId)
      if (!s || !v) return undefined
      if (v.kind === "block") return { type: "skip", result: { error: `Tool call blocked: ${v.text}` } }
      if (v.kind === "unknown") return { type: "skip", result: { error: v.text } }
      // 纵深防御（第二波返修 B1）：引擎执行的调用原文必须就是日志里的那份。引擎按客户端带来的历史取调用原文
      // （toolCall.function.arguments），客户端改了历史，执行的就不是时间线上记的调用。比的是原文：按引擎同一规则解析
      // （空串当 "{}"、不是对象当 {}），与日志入参（不是对象当 {}）逐值比，所有工具同一口径、不经 schema——
      // schema 的输出可能带每次求值都不同的缺省值（randomUUID、Date.now），拿它比会误拦普通调用（第三轮返修 A）。
      // 原生审批的 editedArgs 不改原文，由 init 交给引擎的"已取消"拦（s.editRefused）
      const block = (text: string) => {
        s.verdicts.set(hookCtx.toolCallId, { kind: "block", text })
        return { type: "skip" as const, result: { error: `Tool call blocked: ${text}` } }
      }
      if (s.callArgs.has(hookCtx.toolCallId)) {
        const logged = s.callArgs.get(hookCtx.toolCallId)
        const expected = typeof logged === "object" && logged !== null ? logged : {}
        let actual: unknown
        try {
          const parsed: unknown = JSON.parse(hookCtx.toolCall.function.arguments.trim() || "{}")
          actual = typeof parsed === "object" && parsed !== null ? parsed : {}
        } catch {
          actual = undefined
        }
        if (actual === undefined || !sameArgs(actual, expected))
          return block(
            `the call about to run (${hookCtx.toolCall.function.arguments}) differs from the call in the timeline, so it was not executed. Make the call again if you still need it`,
          )
      }
      // 引擎逐个 await 本钩子后立刻执行该工具，所以这里就是"execute 之前"：不可重放的先记开始动手（与 runLoop 同一判据；
      // TanStack 宿主工具的 risk 只从 metadata.reins 读，没声明的按缺省口径算写工具）
      const tool = toolNamed(s, hookCtx.toolName)
      // 原生审批的第二条答复通道：UIMessage 的 approval-responded 部件（引擎构造时读出，不经 resume，init 看不到）。
      // 引擎只在批准后才对带静态 needsApproval 的工具调本钩子，所以这里见到仍在等审批的调用 = 已批准，执行前补记结论（#5）
      if (tool && isNativeToolView(tool) && tool.needsApproval === true) {
        const timeline = await timelineOf()
        const awaiting = awaitingOf({
          timeline,
          pending: pendingToolCalls(timeline),
          tools: [],
          interruptions: [],
        }).some((a) => a.kind === "approval" && a.toolCallId === hookCtx.toolCallId)
        if (awaiting) {
          const parentId = s.callEventIds.get(hookCtx.toolCallId)
          await markResumed(ctx, s, TANSTACK_DECIDER)
          await append(ctx, s, [
            {
              type: "core.approval_decision",
              actor: "host",
              ...(parentId !== undefined ? { parentId } : {}),
              payload: { toolCallId: hookCtx.toolCallId, approved: true, by: TANSTACK_DECIDER },
            },
          ])
          // 批准到这时才入日志，beforeTools 边界的 Socket 管线早已判完：按批准后的时间线重跑一遍，只认 block——
          // approval({ ttlMs }) 的过期拒绝等按"批准事件"判的规则在这条通道上同样生效（第二波返修 S1）
          const refused = await rerunForBlock(ctx, s, hookCtx.toolCallId, tool)
          if (refused !== undefined) return block(refused)
        }
      }
      if (v.kind !== "await" && (tool === undefined || !isReplayable(tool))) {
        const parentId = s.callEventIds.get(hookCtx.toolCallId)
        await append(ctx, s, [
          {
            type: "core.tool_started",
            actor: "system",
            ...(parentId !== undefined ? { parentId } : {}),
            payload: { toolCallId: hookCtx.toolCallId },
          },
        ])
      }
      if (v.kind === "rewrite") return { type: "transformArgs", args: v.args }
      return undefined
    },

    async onAfterToolCall(ctx, info) {
      const s = states.get(ctx)
      if (!s) return
      await afterTool(ctx, s, info)
    },

    async onToolPhaseComplete(ctx, info) {
      const s = states.get(ctx)
      if (!s) return
      await toolPhaseComplete(ctx, s, info)
    },

    async onShouldContinue(ctx, state) {
      const s = states.get(ctx)
      if (!s?.turn) return undefined
      const tctx = s.turn.ctx
      tctx.budget.wallMs = now() - s.startedAt
      let decision: TurnDecision = state.lastTurnToolCallCount > 0 ? "continue" : "stop"
      // 本 run 已写过终结事件（工具阶段因审批 / 客户端工具暂停）时这一轮是被挂起的，不问 Socket——与 runLoop
      // "有中断不进 onTurnEnd"同口径。否则 Socket 的暂停 / 交接会在那条 run_paused 后面再落一条终结事件，盖掉"在等谁"
      if (!s.ended) {
        for (const sock of sockets) {
          const d = await sock.onTurnEnd?.(tctx)
          if (d !== undefined) {
            decision = d
            break
          }
        }
      }
      await flush(ctx, s)
      if (decision === "continue") return true
      if (decision === "stop") return false
      if ("pause" in decision) {
        // 原因码与说明随暂停落库（AdRate 建议 16）：与 runLoop 调同一对函数，同一个 Socket 在两条路径上留下同样的记录。
        // 意见里不合规的地方已被改正，改正处先记一条非终结 core.error，照常暂停
        const { interruption, error } = resolveSocketPause(decision.pause)
        await append(ctx, s, [
          ...(error !== undefined
            ? [{ type: "core.error" as const, actor: "system" as const, payload: error }]
            : []),
          {
            type: "core.run_paused",
            actor: "system",
            payload: { reason: interruption.kind, ...pauseDetailOf([interruption]) },
          },
        ])
        return false
      }
      await doHandoff(ctx, s, decision.handoff)
      return false
    },

    async onFinish(ctx) {
      const s = states.get(ctx)
      if (!s || s.ended) return
      await append(ctx, s, s.assembler.finish())
      // 引擎提前结束（如通用中断按 stop 策略续跑）时日志里可能还有没执行的调用：那不是"跑完了"，不写终结记号（判 unknown）
      if (pendingToolCalls(await timelineOf()).length > 0) return
      await append(ctx, s, [{ type: "core.run_ended", actor: "system", payload: { status: "done" } }])
    },

    async onAbort(ctx) {
      const s = states.get(ctx)
      if (!s || s.ended) return
      await append(ctx, s, [
        ...s.assembler.finish(),
        { type: "core.run_paused", actor: "system", payload: { reason: "host" } },
      ])
    },

    async onError(ctx, info) {
      const s = states.get(ctx)
      if (!s) return
      await append(ctx, s, [
        ...s.assembler.finish(),
        {
          type: "core.error",
          actor: "system",
          payload: { category: TANSTACK_API, message: errorMessageOf(info.error), retryable: false },
        },
        // 与 core.error 同批原子写入；本 run 已有终结事件时只记错误，不再收尾第二次
        ...(s.ended
          ? []
          : [
              {
                type: "core.run_ended" as const,
                actor: "system" as const,
                payload: { status: "error" as const, category: TANSTACK_API },
              },
            ]),
      ])
    },
  }
  return middleware
}
