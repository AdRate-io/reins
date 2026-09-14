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
 *   onAbort / onError     run_paused(host) / core.error
 *
 * 与默认循环的已知差异（有损声明，见技术方案 §11 / DECISIONS）：
 * - TanStack 消息无 system 角色，system_note 以 <system_note> 标签走 user；thinking 无同源签名不下发
 * - defer 让整轮工具都等审批（TanStack 在边界暂停不执行任何调用）；默认循环会先执行不需审批的
 * - onTurnEnd 的 "continue" 只在 TanStack 自己也想继续时生效；pause 表现为 run 正常结束 + run_paused 事件
 * - handoff 只做记录与新会话开头，宿主在下一次请求里改用新 sessionId
 * - 模型看到的是日志投影（providerMessages），TanStack 自己的 messages 数组只给客户端 UI 与它的内部对账用
 */
import {
  type BeforeToolDecision,
  type BlobStore,
  BUILTIN_APPROVAL_POLICY,
  type CoreEvent,
  type CoreEventOf,
  computeConfigHash,
  createCoreRegistry,
  createEvent,
  DEFAULT_MODEL_INVISIBLE_TYPES,
  type Event,
  type EventDraft,
  type EventLog,
  type EventSchemaRegistry,
  errorMessageOf,
  type HandoffIntent,
  type LandingRecord,
  type LoweringCapabilities,
  type MaybePromise,
  type MemoryStore,
  type ModelRef,
  type Principal,
  type ProjectionStrategy,
  pendingToolCalls,
  project,
  readTimeline,
  resolveSocketContributions,
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
  toolResultTrust,
  toolsBoundDrafts,
  uuidv7,
} from "@reinsjs/core"
import type {
  AfterToolCallInfo,
  AnyTool,
  ChatMiddleware,
  ChatMiddlewareConfig,
  ChatMiddlewareContext,
  StreamChunk,
  SystemPrompt,
  TokenUsage as TanstackUsage,
  ToolPhaseCompleteInfo,
} from "@tanstack/ai"
import { GenericInterruptDefinitionRegistryCapability } from "@tanstack/ai/adapter-internals"
import { BlockAssembler } from "./assembler.js"
import { fromTanstackToolResult } from "./content.js"
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

interface TurnState {
  ctx: TurnContext
  /** 本轮投影估算，进 budget_usage.contextEstimate */
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
  assembler: BlockAssembler
  turn?: TurnState
  /** 已包装成 TanStack 工具的 reins 工具（按名字缓存，保持引用稳定） */
  wrapped: Map<string, AnyTool>
  /**
   * 宿主是否把 `reinsApprovalInterrupt` 登记到了 `chat({ interrupts })`（R7）。没登记时引擎会在边界抛
   * "not registered on this chat"，run 死在一条永远等不到答复的 run_paused 上；所以 init 就查，没登记则 defer 降级为拒绝
   */
  approvalInterruptRegistered: boolean
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
  const registry = options.registry ?? createCoreRegistry()
  const now = options.now ?? (() => Date.now())
  const newId = options.newId ?? uuidv7
  const warn = options.warn ?? ((m: string) => console.warn(`[reins/adapter-tanstack-ai] ${m}`))
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
    const hostViews = config.tools.map(viewOfTanstackTool)
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
      assembler: new BlockAssembler({ provider: model.provider, api: TANSTACK_API, model: model.id }),
      wrapped: new Map(),
      approvalInterruptRegistered: approvalInterruptRegistered(ctx),
    }
    states.set(ctx, s)
    // ToolContext.spend（§10.1 ④）：工具代跑的子代理用量计入本 run 的预算，budget 模块按总账拦
    s.bridge.toolContextBase.spend = (usage) => {
      s.tokensSpent += usage.input + usage.output
      if (s.turn) s.turn.ctx.budget.tokensSpent = s.tokensSpent
    }
    if (!s.approvalInterruptRegistered)
      warn(
        "reinsApprovalInterrupt 未登记到 chat({ interrupts })，本次 run 无法请求人工审批：需要审批的工具调用一律按拒绝处理（fail-closed）",
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
      if (imported.dropped.length > 0) warn(`导入客户端消息时有片段未能翻译：${imported.dropped.join(", ")}`)
      // 网络重试 / 客户端重放会把同一条用户消息再发一遍：日志里已有同键同内容的就跳过，不让它入日志两次
      const { drafts, skipped } = dedupeImportedUserMessages(imported.drafts, timeline)
      if (skipped > 0) warn(`客户端重发了 ${skipped} 条已在日志里的用户消息（网络重试？），已跳过`)
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
      emit: (d) => s.emitted.push(d),
    }
    return {
      ctx: turnCtx,
      estimate: projected.stats.estimatedTokens,
      startedAt: turnStartedAt,
      toolCalls: 0,
      modelEvents: [],
    }
  }

  // ---- beforeModel：投影 + Socket 补丁 → providerMessages / tools / systemPrompts ----
  const beforeModel = async (
    ctx: ChatMiddlewareContext,
    s: RunState,
  ): Promise<Partial<ChatMiddlewareConfig>> => {
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
    visible = [...visible, ...injected.filter((e) => !DEFAULT_MODEL_INVISIBLE_TYPES.has(e.type))]
    tctx.events = visible
    tctx.tools = tools
    s.turn = turn
    s.assembler.reset()

    const { messages, landings } = toModelMessages(visible, {
      model: s.model,
      ...(options.trustMarkers !== undefined ? { trustMarkers: options.trustMarkers } : {}),
    })
    options.onLandings?.(landings.filter((l) => l.kind !== "exact"))
    return {
      providerMessages: messages,
      tools: tanstackToolsOf(s, tools),
      systemPrompts: systemPrompt !== undefined ? [systemPrompt] : s.systemPrompts,
    }
  }

  // ---- beforeTools 边界：对每个待执行调用跑 beforeTool 管线，结论缓存；defer → 通用中断 ----
  const beforeTools = async (ctx: ChatMiddlewareContext, s: RunState) => {
    const timeline = await timelineOf()
    const pending = pendingToolCalls(timeline)
    if (pending.length === 0) return undefined
    if (!s.turn) s.turn = await buildTurn(ctx, s, timeline) // 续跑补齐：还没问过模型
    const tctx = s.turn.ctx
    const decisions = new Map<string, CoreEventOf<"core.approval_decision">["payload"]>()
    const requested = new Set<string>()
    for (const raw of timeline) {
      const e = raw as CoreEvent
      if (e.type === "core.approval_decision") decisions.set(e.payload.toolCallId, e.payload)
      if (e.type === "core.approval_request") requested.add(e.payload.toolCallId)
    }

    const interrupts: ReturnType<ReinsApprovalInterrupt["interrupt"]>[] = []
    for (const call of pending) {
      const { toolCallId, name } = call.payload
      const tool = tctx.tools.find((t) => t.name === name)
      const decided = decisions.get(toolCallId)
      if (decided && !decided.approved) {
        s.verdicts.set(toolCallId, {
          kind: "block",
          text: `审批被拒绝${decided.reason ? `：${decided.reason}` : ""}`,
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
      // 执行时 toTanstackTool 会以"入参不合法"报错
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
          const need =
            typeof tool.needsApproval === "function"
              ? await tool.needsApproval(input, {
                  ...toolContextBase(),
                  toolCallId,
                  emit: (d) => s.emitted.push(d),
                })
              : tool.needsApproval
          if (need)
            approval = {
              policyId: BUILTIN_APPROVAL_POLICY,
              summary: `${name}(${JSON.stringify(input) ?? ""})`,
            }
        }
      }
      if (approval && !decided?.approved) {
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
            "审批中断未登记（chat({ interrupts }) 缺 reinsApprovalInterrupt），无法请求人工审批，按拒绝处理"
          s.emitted.push({
            type: "core.approval_decision",
            actor: "system",
            parentId: call.id,
            payload: { toolCallId, approved: false, by: "reins", reason },
          })
          s.verdicts.set(toolCallId, { kind: "block", text: `审批被拒绝：${reason}` })
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
      s.verdicts.set(toolCallId, rewritten ? { kind: "rewrite", args } : { kind: "proceed" })
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

    if (verdict?.kind === "block") {
      // 拦截：不经 afterTool，留痕（如 approval_decision）先落
      await settle(
        ctx,
        s,
        resultDraft(call, info.toolCallId, info.toolName, errorResult(`工具调用被拦截：${verdict.text}`)),
      )
      return
    }
    let result: ToolResult
    if (stored) result = stored
    else if (info.ok) result = { content: fromTanstackToolResult(info.result), isError: false }
    else result = errorResult(`工具执行失败：${errorMessageOf(info.error)}`)
    s.toolCallsTotal++
    if (s.turn) s.turn.ctx.budget.toolCalls = s.toolCallsTotal

    let draft = resultDraft(call, info.toolCallId, info.toolName, result, toolNamed(s, info.toolName))
    if (s.turn && call) {
      for (const sock of sockets) {
        const replaced = await sock.afterTool?.(s.turn.ctx, call, draft)
        if (replaced) draft = replaced
      }
    }
    await settle(ctx, s, draft)
  }

  const toolPhaseComplete = async (ctx: ChatMiddlewareContext, s: RunState, info: ToolPhaseCompleteInfo) => {
    const timeline = await timelineOf()
    const answered = new Set<string>()
    const requested = new Set<string>()
    const decided = new Set<string>()
    for (const raw of timeline) {
      const e = raw as CoreEvent
      if (e.type === "core.tool_result") answered.add(e.payload.toolCallId)
      if (e.type === "core.approval_request") requested.add(e.payload.toolCallId)
      if (e.type === "core.approval_decision") decided.add(e.payload.toolCallId)
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
      const content = fromTanstackToolResult(r.result)
      await settle(
        ctx,
        s,
        resultDraft(call, r.toolCallId, r.toolName, { content, isError }, toolNamed(s, r.toolName)),
      )
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
    await append(ctx, s, [
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
    const opening: EventDraft[] = [
      { type: "core.system_note", actor: "host", payload: { kind: "host", text: intent.summary } },
      ...(intent.opening ?? []),
    ]
    if (intent.triggerMessage !== undefined)
      opening.push({
        type: "core.user_message",
        actor: "user",
        payload: { content: [{ type: "text", text: intent.triggerMessage }] },
      })
    const events = opening.map((d, i) =>
      createEvent(registry, { ...d, sessionId: toSessionId, seq: i + 1, at, id: newId(at) }),
    )
    await log.append(events)
    for (const e of events) options.onEvent?.(e)
    await options.onHandoff?.(sessionId, toSessionId)
  }

  const middleware: ReinsChatMiddleware = {
    name: "reins",

    async onConfig(ctx, config) {
      if (ctx.phase === "init") {
        const s = await initRun(ctx, config)
        return { tools: tanstackToolsOf(s, s.baseTools), systemPrompts: s.systemPrompts }
      }
      const s = states.get(ctx)
      if (!s) return undefined
      if (ctx.phase === "beforeModel" || ctx.phase === "structuredOutput") return beforeModel(ctx, s)
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
      for (const r of resolutions.for(reinsApprovalInterrupt)) {
        const approved = r.status === "resolved" && r.response.approved === true
        const by = r.status === "resolved" && r.response.by ? r.response.by : TANSTACK_DECIDER
        const reason = r.status === "resolved" ? r.response.reason : "审批被取消"
        s.emitted.push({
          type: "core.approval_decision",
          actor: "host",
          payload: { toolCallId: r.request.key, approved, by, ...(reason !== undefined ? { reason } : {}) },
        })
      }
      const events = await flush(ctx, s)
      if (events.length > 0) await append(ctx, s, [{ type: "core.run_resumed", actor: "host", payload: {} }])
      return { toolResume: "continue" }
    },

    onBeforeToolCall(ctx, hookCtx) {
      const s = states.get(ctx)
      const v = s?.verdicts.get(hookCtx.toolCallId)
      if (!v) return undefined
      if (v.kind === "block") return { type: "skip", result: { error: `工具调用被拦截：${v.text}` } }
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
      for (const sock of sockets) {
        const d = await sock.onTurnEnd?.(tctx)
        if (d !== undefined) {
          decision = d
          break
        }
      }
      await flush(ctx, s)
      if (decision === "continue") return true
      if (decision === "stop") return false
      if ("pause" in decision) {
        await append(ctx, s, [
          { type: "core.run_paused", actor: "system", payload: { reason: decision.pause.reason } },
        ])
        return false
      }
      await doHandoff(ctx, s, decision.handoff)
      return false
    },

    async onAbort(ctx) {
      const s = states.get(ctx)
      if (!s) return
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
      ])
    },
  }
  return middleware
}
