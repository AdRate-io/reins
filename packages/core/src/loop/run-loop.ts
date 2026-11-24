/**
 * runLoop：reins 的默认循环（技术方案 §2、§6、§7）。
 *
 * 这是一个导出的普通异步生成器，没有私有状态，用户可以整个复制去改（P3）。它每一轮做的事：
 *
 *   timeline  = readTimeline(log, session, { registry }) ← 时间线是唯一真源（宪法二）；读时按注册表升级（P9）
 *   补齐日志里还没结果的 tool_call                       ← 进程死亡 / 审批恢复 / 客户端工具回填后的续跑
 *   view      = project(timeline)                        ← 过滤 → 折叠 → 钉住 → 预算裁剪
 *   beforeModel 钩子                                     ← 脑子注入 system_note（感知等）、改投影、增删工具
 *   request   = lowering.toRequest(view, tools)          ← 事件 → 某家 API 请求（角色只在这里出现）
 *   for draft of lowering.stream(request): append        ← 模型说的每一块都立刻入日志
 *   afterModel 钩子
 *   for call of toolCalls: beforeTool → execute → afterTool → append tool_result
 *   append budget_usage
 *   onTurnEnd 钩子 → continue | stop | handoff | pause
 *
 * 生成器 yield 的是每一条刚 append 进日志的事件（宿主拿去推给前端）；返回值是 RunResult 四态之一。
 * 暂停是显式返回值（P6）：审批、预算、宿主中止、客户端工具都走同一条路 —— 写 run_paused、返回可序列化状态；
 * 恢复就是用同一个 sessionId 再跑一次 runLoop，第一步"补齐未完成的 tool_call"会接上。
 *
 * 决策权在模型（宪法一）：循环自己不判断"该不该继续"以外的任何事。它只在两处兜底 ——
 * 工具声明 needsApproval 而没有 Socket 做主时转审批；轮数超过 maxTurns 时暂停。
 */
import type { Actor, ContentPart, Event, Trust } from "../events/base.js"
import type {
  ApprovalDecisionPayload,
  CoreEvent,
  CoreEventOf,
  ErrorPayload,
  TokenUsage,
} from "../events/core.js"
import { createEvent, type EventDraft } from "../events/create.js"
import { uuidv7 } from "../events/id.js"
import { createCoreRegistry, type EventSchemaRegistry } from "../events/registry.js"
import { type LoweringOutcome, type LoweringStreamContext, lossesOf } from "../lowering/types.js"
import { estimateTotal, roughTokenEstimate } from "../projection/estimate.js"
import { isModelInvisibleByDefault } from "../projection/filter.js"
import { project, resolveReserveTokens } from "../projection/project.js"
import { readTimeline } from "../store/read-timeline.js"
import { toolBatchOf } from "./batch.js"
import { handoffOpeningDrafts } from "./handoff.js"
import {
  type CheckImageRefsContext,
  checkImageRefs,
  hydrateImageRefs,
  type ImageRefCache,
  isImageRef,
  judgeImageRef,
  prefetchImageRefs,
} from "./media-refs.js"
import { MAX_TURNS_PAUSE_CODE, pauseDetailOf, resolveSocketPause } from "./pause-code.js"
import { type ModelCallFailure, resolveRetry } from "./retry.js"
import { awaitingOf } from "./run-status.js"
import {
  assertDecisionsAwaitApproval,
  computeConfigHash,
  pendingToolCalls,
  serializeRunState,
  validateResume,
} from "./state.js"
import { resolveSocketContributions } from "./static.js"
import {
  isReplayable,
  isStopped,
  MODEL_FAILED_NOT_EXECUTED_TEXT,
  MODEL_INTERRUPTED_NOT_EXECUTED_TEXT,
  outcomeUnknownText,
  type StopTexts,
  stopTextsOf,
  toolStartedAt,
} from "./stop.js"
import { isSubagentPause } from "./subagent.js"
import {
  deferredToolSpecOf,
  errorMessageOf,
  isClientTool,
  isContentPart,
  normalizeToolOutput,
  toolResultTrust,
} from "./tools.js"
import { toolsBoundDrafts } from "./tools-bound.js"
import type {
  ApprovalDecisionInput,
  BeforeToolDecision,
  Interruption,
  LoopConfig,
  PauseReason,
  RunResult,
  Socket,
  Tool,
  ToolCallEvent,
  ToolContext,
  ToolResultDraft,
  ToolResultEvent,
  TurnContext,
  TurnDecision,
} from "./types.js"

export const DEFAULT_MAX_TURNS = 100

/** 循环内置的审批策略标识：工具自己声明 needsApproval 且没有 Socket 做主 */
export const BUILTIN_APPROVAL_POLICY = "tool.needsApproval"

/**
 * 宿主经 `input` 能直接追加的草稿类型：用户说话、给客户端工具回填结果、宿主说明、宿主自己的 ext.* 事件。
 * 模型输出与运维事件（approval_decision、run_resumed、compaction、budget_usage…）不许从这条路进来：
 * 一条伪造的 approval_decision(approved=true) 就能让 pending 调用免审批执行，伪造的 compaction 能把历史藏起来。
 * 这些事件只能由循环自己按规则产生（审批结论走 `decisions`，经 T10 校验）。
 */
export const INPUT_DRAFT_TYPES: ReadonlySet<string> = new Set([
  "core.user_message",
  "core.tool_result",
  "core.system_note",
])

const INPUT_ACTORS: ReadonlySet<string> = new Set<Actor>(["user", "model", "tool", "system", "host"])
const CONTENT_PART_TYPES: ReadonlySet<string> = new Set(["text", "image", "video", "audio", "tool_reference"])

/**
 * 数组元素归类：片段（ContentPart，无 actor）还是草稿（带 actor，或 type 为 core.* / ext.*）。
 * 漏写 actor 的 core.* 元素也归草稿，好在白名单那步被拒，而不是静默变成一条怪异的用户消息
 */
function classifyInputItem(item: unknown): "part" | "draft" | undefined {
  if (typeof item !== "object" || item === null) return undefined
  const { type, actor } = item as { type?: unknown; actor?: unknown }
  if (actor !== undefined) return "draft"
  if (typeof type !== "string") return undefined
  if (type.startsWith("core.") || type.startsWith("ext.")) return "draft"
  return CONTENT_PART_TYPES.has(type) ? "part" : undefined
}

const NOTE_KINDS: ReadonlySet<string> = new Set(["perception", "pin", "budget", "host"])

/** 内容片段数组的形状校验；单个片段的规则只在 `isContentPart`（tools.ts），与工具返回值同一口径 */
function isContentPartList(x: unknown): boolean {
  return Array.isArray(x) && x.every(isContentPart)
}

/** 三种 core 输入草稿的 payload 最小形状；ext.* 的形状归宿主自己的注册表 */
function corePayloadProblem(draft: EventDraft): string | undefined {
  const p = (typeof draft.payload === "object" && draft.payload !== null ? draft.payload : {}) as Record<
    string,
    unknown
  >
  if (draft.type === "core.user_message")
    return isContentPartList(p.content) ? undefined : "payload.content must be an array of content parts"
  if (draft.type === "core.tool_result") {
    if (typeof p.toolCallId !== "string" || typeof p.name !== "string")
      return "payload.toolCallId and payload.name must be strings"
    return isContentPartList(p.content) ? undefined : "payload.content must be an array of content parts"
  }
  if (draft.type === "core.system_note") {
    if (typeof p.kind !== "string" || !NOTE_KINDS.has(p.kind))
      return `payload.kind must be perception, pin, budget or host, got ${String(p.kind)}`
    return typeof p.text === "string" ? undefined : "payload.text must be a string"
  }
  return undefined
}

/** 单条草稿过类型白名单、actor 与 core 载荷形状校验；不合规抛 RangeError */
function checkInputDraft(draft: EventDraft): EventDraft {
  if (
    typeof draft.type !== "string" ||
    (!INPUT_DRAFT_TYPES.has(draft.type) && !draft.type.startsWith("ext."))
  ) {
    throw new RangeError(
      `input draft rejects event type ${String(draft.type)}: only core.user_message, core.tool_result, core.system_note or ext.* are accepted`,
    )
  }
  if (typeof draft.actor !== "string" || !INPUT_ACTORS.has(draft.actor)) {
    throw new RangeError(
      `input draft actor must be user, model, tool, system or host, got ${String(draft.actor)}`,
    )
  }
  const problem = corePayloadProblem(draft)
  if (problem !== undefined) throw new RangeError(`input draft ${draft.type}: ${problem}`)
  return draft
}

/**
 * 把 `input` 归一成草稿列表：字符串 / 内容片段 → 一条 user_message；单条草稿 → 一条；草稿数组 → 按序多条。
 * 全部校验完才返回，任一不合规在写任何日志之前就抛 RangeError（fail-closed）。片段与草稿混排、无法归类的元素一律拒绝
 */
export function inputDrafts(input: NonNullable<LoopConfig["input"]>): EventDraft[] {
  if (typeof input === "string")
    return [
      { type: "core.user_message", actor: "user", payload: { content: [{ type: "text", text: input }] } },
    ]
  if (isInputArray(input)) {
    const kinds = new Set(input.map(classifyInputItem))
    if (kinds.has(undefined) || kinds.size > 1) {
      throw new RangeError(
        `input must be content parts or event drafts, got ${kinds.size > 1 && !kinds.has(undefined) ? "a mix of both" : "an element that is neither"}`,
      )
    }
    // 空数组沿用现状当片段
    if (!kinds.has("draft")) {
      if (!isContentPartList(input)) throw new RangeError("input content parts are malformed")
      return [{ type: "core.user_message", actor: "user", payload: { content: input as ContentPart[] } }]
    }
    return (input as readonly EventDraft[]).map(checkInputDraft)
  }
  return [checkInputDraft(input)]
}

/**
 * run 进行中拉到的草稿（`pullInput`）可写的类型：比 INPUT_DRAFT_TYPES 少 tool_result——
 * 拉取点只在本轮没有 pending 时出现，此时写进来的 tool_result 不是孤儿就是重复 id
 */
const PULLED_DRAFT_TYPES: ReadonlySet<string> = new Set(["core.user_message", "core.system_note"])

/**
 * 校验 `pullInput` 的返回值：是数组 → 逐条过收窄白名单与 `checkInputDraft` → 逐条查注册表。
 * 全部通过才返回；不合规抛 RangeError（循环据此以 error 结束，这一批一条不写）
 */
function checkPulledDrafts(value: unknown, registry: EventSchemaRegistry): EventDraft[] {
  if (!Array.isArray(value)) {
    throw new RangeError(`pullInput must return an array of event drafts, got ${describe(value)}`)
  }
  return value.map((raw: unknown) => {
    const draft = (typeof raw === "object" && raw !== null ? raw : {}) as EventDraft
    const type = draft.type
    if (typeof type !== "string" || (!PULLED_DRAFT_TYPES.has(type) && !type.startsWith("ext."))) {
      throw new RangeError(
        `pullInput draft rejects event type ${String(type)}: only core.user_message, core.system_note or ext.* are accepted`,
      )
    }
    checkInputDraft(draft)
    if (!registry.has(type)) throw new RangeError(`pullInput draft type ${type} is not registered`)
    return draft
  })
}

/** 把宿主抛出的任意值变成一句话；String() 本身会抛（如 Object.create(null)）时也不能让 fail-open 变成 run 崩溃 */
function describeThrown(value: unknown): string {
  if (value instanceof Error) return value.message
  try {
    return String(value)
  } catch {
    return "a value that cannot be printed"
  }
}

function describe(value: unknown): string {
  return value === null ? "null" : typeof value
}

/** Array.isArray 对 readonly 数组收窄不够，单独写一个守卫 */
function isInputArray(
  input: NonNullable<LoopConfig["input"]>,
): input is ContentPart[] | readonly EventDraft[] {
  return Array.isArray(input)
}

/**
 * 起步 input 里的 tool_result 草稿对账 pending（全库审查 2026-11-25 #15）：toolCallId 必须正 pending、名字与那次调用相同、
 * 同一批里不重复、且不在等审批。不过就抛 RangeError（调用方在写任何日志之前调）。日志只追加，重复或孤儿结果一旦写下，
 * 降级层每次请求都会原样下发，厂商持续 400；在等审批的调用直接回填结果等于绕过审批（结论只能经 decisions 交），
 * "在等审批"与 server 的 409 approval_pending 同一判定（awaitingOf）。pullInput 干脆不收 tool_result。
 * 与 server checkInput 的刻意差异：server 还拒绝回填服务端工具（只收客户端工具的结果），进程内宿主是受信代码、可以替任何 pending 调用回填
 */
function checkInputToolResults(input: readonly EventDraft[], timeline: readonly Event[]): void {
  const results = input.filter((d) => d.type === "core.tool_result")
  if (results.length === 0) return
  const pendingCalls = pendingToolCalls(timeline)
  const pending = new Map(pendingCalls.map((c) => [c.payload.toolCallId, c.payload.name]))
  const awaitingApproval = new Set(
    awaitingOf({ timeline, pending: pendingCalls, tools: [], interruptions: [] })
      .filter((a) => a.kind === "approval")
      .map((a) => a.toolCallId),
  )
  const seen = new Set<string>()
  for (const d of results) {
    // 形状已由 checkInputDraft 校验：toolCallId 与 name 都是字符串
    const { toolCallId, name } = d.payload as { toolCallId: string; name: string }
    const expected = pending.get(toolCallId)
    if (expected === undefined || seen.has(toolCallId)) {
      throw new RangeError(
        `input draft core.tool_result: call ${toolCallId} is not pending (already answered, unknown, or answered twice in this input)`,
      )
    }
    if (name !== expected) {
      throw new RangeError(`input draft core.tool_result: name must be ${expected}, got ${name}`)
    }
    if (awaitingApproval.has(toolCallId)) {
      throw new RangeError(
        `input draft core.tool_result: call ${toolCallId} is waiting for approval; pass the decision in decisions first`,
      )
    }
    seen.add(toolCallId)
  }
}

/** 输入草稿里可能带图片引用的内容片段：user_message / tool_result 的 content（形状已由 checkInputDraft 校验），其余为空 */
function draftParts(draft: EventDraft): readonly ContentPart[] {
  if (draft.type !== "core.user_message" && draft.type !== "core.tool_result") return []
  return (draft.payload as { content: ContentPart[] }).content
}

export async function* runLoop(cfg: LoopConfig): AsyncGenerator<Event, RunResult> {
  const { sessionId, log, lowering, model } = cfg
  const registry = cfg.registry ?? createCoreRegistry()
  const now = cfg.now ?? (() => Date.now())
  const newId = cfg.newId ?? uuidv7
  const sockets = cfg.sockets ?? []
  // Socket 的静态贡献在这里并入：工具表与系统提示整个 run 不变（prompt cache），续跑补齐 pending 时也在场。
  // 算法在 static.ts，server 的恢复预校验用同一份，configHash 才对得上。可 await：MCP 模块在此 tools/list（P1）
  const { tools: baseTools, systemPrompt: baseSystemPrompt } = await resolveSocketContributions(cfg)
  const maxTurns = cfg.maxTurns ?? DEFAULT_MAX_TURNS
  const retry = resolveRetry(cfg.retry)
  // 新输入先过类型白名单：不合规在写任何东西之前就拒绝
  const input = cfg.input !== undefined ? inputDrafts(cfg.input) : []
  // 注册表也在写日志前查：未登记的 ext.* 若拖到 append 才失败，tools_bound / run_resumed 已经落了
  for (const d of input) {
    if (!registry.has(d.type)) throw new RangeError(`input draft type ${d.type} is not registered`)
  }
  const capabilities = lowering.capabilities(model)
  // 窗口与预留在写日志前校验（与 project() 同一函数）：拖到投影才抛，tools_bound / input 已经落了
  resolveReserveTokens({
    contextLimit: capabilities.contextWindow,
    ...(cfg.projection?.reserveTokens !== undefined ? { reserveTokens: cfg.projection.reserveTokens } : {}),
  })
  const configHash = await computeConfigHash({
    model,
    tools: baseTools,
    ...(baseSystemPrompt !== undefined ? { systemPrompt: baseSystemPrompt } : {}),
  })

  const startedAt = now()
  // 起步先把整条日志过一遍注册表：有读不出来的事件（未登记的 ext.*、未来版本）就在写任何东西之前拒绝（P9 fail-closed）
  const startTimeline = await readTimeline(log, sessionId, { registry })
  let lastSeq = startTimeline.at(-1)?.seq ?? 0
  // 回填的工具结果对账 pending 与审批（与 server checkInput 的异同见 checkInputToolResults）：在写任何东西之前拒
  checkInputToolResults(input, startTimeline)
  /** run 级图片缓存（blobId → base64）：写入校验与换回共用，同一 blob 一个 run 只读一次 */
  const imageCache: ImageRefCache = new Map()
  // 起步 input 里的图片引用（媒体引用方案）：归属 / mime 不过抛 RangeError、一条不写，与片段形状校验同口径；
  // 存储自己抛错（非 not_found）原样抛出——不知道合不合规就不写。全部草稿的片段按原顺序合成一批：
  // 一波并发读完再按顺序判，报的第一个问题与逐条草稿串行判相同
  const startProblem = await checkImageRefs(input.flatMap(draftParts), {
    sessionId,
    blobs: cfg.blobs,
    timeline: startTimeline,
    cache: imageCache,
  })
  if (startProblem !== undefined) throw new RangeError(startProblem)
  let turns = 0
  let tokensSpent = 0
  let toolCallsTotal = 0

  // ---- 基础动作：草稿 → 事件 → append。seq 只在这里分配 ----
  const append = async (drafts: readonly EventDraft[]): Promise<Event[]> => {
    if (drafts.length === 0) return []
    const at = now()
    const events = drafts.map((d, i) =>
      createEvent(registry, { ...d, sessionId, seq: lastSeq + 1 + i, at, id: newId(at) }),
    )
    await log.append(events)
    lastSeq += events.length
    return events
  }

  /**
   * 用户停止时的收尾（D1）：日志里每个 pending 调用落一条 isError 的 tool_result，按"有没有动过手"分三句——
   * 没 started 的"没执行"；started 且不可重放的"结果未知"（上一个进程执行中死掉的）；started 且可重放的"做了一半"（子代理）。
   * 等审批的、客户端工具的一并收尾：停止就是不做了，下一个 run 直接问模型，由它结合用户的新话决定。
   * "没执行 / 做了一半"的口径随停止原因（`stopTextsOf`：用户停止 vs 宿主收尾遗留调用）
   */
  const settleStopped = async (texts: StopTexts): Promise<Event[]> => {
    const timeline = await readTimeline(log, sessionId, { registry })
    const pending = pendingToolCalls(timeline)
    if (pending.length === 0) return []
    const started = toolStartedAt(timeline)
    return append(
      pending.map((call): ToolResultDraft => {
        const { toolCallId, name } = call.payload
        const tool = baseTools.find((t) => t.name === name)
        const startedAt = started.get(toolCallId)
        // "结果未知"按条件缀开始时间（AdRate 建议 10，口径见 outcomeUnknownText）；"做了一半"不缀——子代理的 started 是暂停后补写的
        const text =
          startedAt === undefined
            ? texts.notExecuted
            : tool !== undefined && isReplayable(tool)
              ? texts.inProgress
              : outcomeUnknownText(tool, startedAt)
        return {
          type: "core.tool_result",
          actor: "tool",
          parentId: call.id,
          provenance: { source: name },
          payload: { toolCallId, name, content: [{ type: "text", text }], isError: true },
        }
      }),
    )
  }

  /**
   * 写 run_paused、返回可序列化状态。所有暂停出口都经这里，所以用户停止（`signal.reason` 是 RunStop）的收尾也挂在这里一次覆盖：
   * 先 settleStopped 再暂停，返回 paused(host)、note 随停止原因（缺省 "stopped by the user"），日志里不再有 pending
   */
  const pause = async (
    requested: PauseReason,
    requestedInterruptions: Interruption[],
  ): Promise<{ events: Event[]; result: RunResult }> => {
    const stopped = isStopped(cfg.signal)
    const texts = stopped ? stopTextsOf(cfg.signal?.reason) : undefined
    const reason: PauseReason = texts ? "host" : requested
    const interruptions: Interruption[] = texts
      ? [{ kind: "host", note: texts.note }]
      : requestedInterruptions
    const settled = texts ? await settleStopped(texts) : []
    // 先签后写（AdRate 建议 8）：状态随 run_paused 一起落进时间线，补发也能交出续跑凭据。
    // pending 以日志为准（而不是本轮内存里的列表），恢复时对账的也是日志；run_paused 本身不改变 pending。
    // lastSeq + 1 就是即将落下的 run_paused 自己的 seq——与此前"写完再算"得到的值逐字相同
    const timeline = await readTimeline(log, sessionId, { registry })
    const pending = pendingToolCalls(timeline)
    // 等外部答复的调用以日志 pending 为准（awaitingOf），停止收尾后 pending 已清空即 []
    const awaiting = awaitingOf({ timeline, pending, tools: baseTools, interruptions })
    const state = await serializeRunState({
      sessionId,
      lastSeq: lastSeq + 1,
      pending,
      configHash,
      model,
      tools: baseTools,
      ...(cfg.secret !== undefined ? { secret: cfg.secret } : {}),
    })
    const events = [
      ...settled,
      ...(await append([
        {
          type: "core.run_paused",
          actor: "system",
          // 原因码与说明随暂停落库（AdRate 建议 16）：取本次中断里 budget / host 那条，口径只走 pauseDetailOf。
          // 用户停止时 interruptions 已换成停止那条，Socket 给的码随之不写
          payload: {
            reason,
            state,
            awaiting,
            ...(texts ? { stopped: true as const } : {}),
            ...pauseDetailOf(interruptions),
          },
        },
      ])),
    ]
    return { events, result: { status: "paused", sessionId, lastSeq, reason, interruptions, state } }
  }

  /** ToolContext.spend 的实现：工具代跑的模型用量（子代理）计入本 run 的 tokensSpent，父 budget 模块按总账拦（§10.1 ④） */
  const spendInto = (ctx: TurnContext) => (usage: TokenUsage) => {
    tokensSpent += usage.input + usage.output
    ctx.budget.tokensSpent = tokensSpent
  }

  /**
   * 以 error 收尾：core.error 与终结记号 run_ended(error) 同批原子写入。非终结的 error（重试前、pullInput 抛错）不走这里。
   * `settle` 是要排在 error 之前、同批写入的收尾结果（模型响应半途失败时，这次响应里的调用）
   */
  const fail = async (
    payload: ErrorPayload,
    settle: readonly EventDraft[] = [],
  ): Promise<{ events: Event[]; result: RunResult }> => {
    const events = await append([
      ...settle,
      { type: "core.error", actor: "system", payload },
      { type: "core.run_ended", actor: "system", payload: { status: "error", category: payload.category } },
    ])
    const error = events[settle.length] as CoreEventOf<"core.error">
    return { events, result: { status: "error", sessionId, lastSeq, error } }
  }

  // ---- 恢复与审批结论：先做完全部校验（不通过就抛，一条日志都不写），再写 run_resumed 与 approval_decision ----
  // 结论按 sessionId 分两路（§10.1）：本会话的校验并记事件；指向别的会话（子代理）的不校验、不记，原样经 ToolContext.decisions 转发给工具
  const ownDecisions = (cfg.decisions ?? []).filter(
    (d) => d.sessionId === undefined || d.sessionId === sessionId,
  )
  const forwardedDecisions: readonly ApprovalDecisionInput[] = (cfg.decisions ?? []).filter(
    (d) => d.sessionId !== undefined && d.sessionId !== sessionId,
  )
  const resuming = cfg.resume !== undefined || ownDecisions.length > 0
  if (resuming) {
    const timeline = await readTimeline(log, sessionId, { registry })
    if (cfg.resume !== undefined) {
      await validateResume({
        state: cfg.resume,
        sessionId,
        timeline,
        configHash,
        model,
        tools: baseTools,
        ...(cfg.secret !== undefined ? { secret: cfg.secret } : {}),
        ...(cfg.allowConfigDrift !== undefined ? { allowConfigDrift: cfg.allowConfigDrift } : {}),
      })
    }
    // 结论只收正在等审批的调用（不只是 pending）：口径在 state.ts，server 的 HTTP 预校验调同一个函数
    assertDecisionsAwaitApproval({ sessionId, timeline, decisions: ownDecisions })
  }

  // ---- 工具表快照（P1）：每次 run 起步一条模型不可见的 tools_bound；与上一条比对有增删则再追加模型可见的说明 ----
  // 放在校验之后（校验不过一条日志都不写）、run_resumed / approval_decision 与新输入之前：tools_bound 是每个 run 的第一条事件，
  // 带 marksEnd 承诺本 run 以终结事件收尾（会话运行状态）。审批结论若排在它前面，进程死在两者之间时最后一条标记仍是旧的
  // paused(approval)，而那个调用其实已有结论。说明先于用户这次的话，模型读到问题时已知道手里的工具变了。
  // 起步时已中止的 run（server 空闲停止、asTool 收尾子会话）不问模型，快照与说明一起跳过：只跳说明的话，
  // 下一个真 run 与这条快照比对不出变化，模型就永远收不到"工具变了"；这种 run 仍以 run_paused 收尾
  if (!cfg.signal?.aborted) {
    yield* await append(
      toolsBoundDrafts({
        timeline: await readTimeline(log, sessionId, { registry }),
        toolNames: baseTools.map((t) => t.name),
        configHash,
        announce: cfg.announceToolChanges ?? true,
        marksEnd: true,
      }),
    )
  }

  if (resuming) {
    const decisions = ownDecisions
    if (cfg.resume !== undefined) {
      const by = decisions[0]?.by
      yield* await append([
        { type: "core.run_resumed", actor: "host", payload: by !== undefined ? { by } : {} },
      ])
    }
    // 结论记成事件，之后"补齐 pending 调用"按它办
    yield* await append(
      decisions.map((d) => ({
        type: "core.approval_decision" as const,
        actor: "host" as const,
        payload: {
          toolCallId: d.toolCallId,
          approved: d.approved,
          by: d.by,
          ...(d.reason !== undefined ? { reason: d.reason } : {}),
        },
      })),
    )
  }

  // ---- 新输入 ----
  // 日志里还有没结果的 tool_call 时，新输入照样追加在此（时间线如实记录"用户此时插话"，宪法二）；
  // 工具结果随后补齐、排在它之后，"tool_result 必须紧跟 tool_use"由降级层把用户消息后移来满足，不改日志顺序
  // 草稿数组一次 append：同一 at、连续 seq，顺序由宿主定（推荐背景在前，与 handoff 开场同一写法）
  yield* await append(input.map((d) => withResultTrust(d, baseTools)))

  while (true) {
    // 宿主中止：先于投影与"补齐 pending"检查。先于补齐：否则上一轮在工具批中途被中止时，余下的调用会在这里被当成 pending
    // 继续执行，一轮一个直到跑完才暂停 —— 中止就成了空话；没执行的调用留作 pending，恢复时再补。
    // 先于投影：不问模型的 run 不该触发阈值整理、往日志里写 compaction
    if (cfg.signal?.aborted) {
      const { events, result } = await pause("host", [
        { kind: "host", note: "host aborted before this turn started" },
      ])
      yield* events
      return result
    }
    const turnStartedAt = now()
    let timeline: readonly Event[] = await readTimeline(log, sessionId, { registry })

    // ---- 拉取 run 进行中的新输入（OnSet 建议 13）：只在要问模型的轮次、投影之前 ----
    // 补跑轮不问模型，拉了会把新输入夹在 tool_call 与补出的 tool_result 之间；触顶即暂停，拉了没人回答
    if (cfg.pullInput !== undefined && turns < maxTurns && pendingToolCalls(timeline).length === 0) {
      let raw: unknown = []
      let thrown: { value: unknown } | undefined
      try {
        raw = await cfg.pullInput({ sessionId, turn: turns + 1 })
      } catch (err) {
        thrown = { value: err }
      }
      // 拉取期间被中止：不论回调返回什么、抛了什么（宿主常把同一个 signal 传给读库，回调因此 reject），一条都不写，
      // 回顶部按"本轮开始前中止"暂停——宿主没见到写入事件就不认领，消息仍在队列
      if (cfg.signal?.aborted) continue
      /** 回调抛错、或校验拉到的图片引用时存储抛错：多半是宿主读库之类的瞬时失败，只记一条（模型不可见），当这次没有、run 照跑 */
      const hostFailure = async (message: string): Promise<Event[]> =>
        append([
          {
            type: "core.error",
            actor: "system",
            payload: { category: "host", message, retryable: true, detail: { phase: "pullInput" } },
          },
        ])
      if (thrown !== undefined) {
        // 消息还在宿主队列里
        const errors = await hostFailure(`pullInput threw: ${describeThrown(thrown.value)}`)
        yield* errors
        timeline = [...timeline, ...errors]
      } else {
        let pulled: EventDraft[]
        /** 不合规的话（形状、类型、图片引用归属）；undefined 即合规 */
        let problem: string | undefined
        /** 校验图片引用时存储自己抛的错 */
        let storageFailure: { value: unknown } | undefined
        try {
          pulled = checkPulledDrafts(raw, registry)
        } catch (err) {
          pulled = []
          problem = describeThrown(err)
        }
        // 拉到的全部草稿合成一批校验（与起步 input 同口径）
        if (problem === undefined) {
          try {
            problem = await checkImageRefs(pulled.flatMap(draftParts), {
              sessionId,
              blobs: cfg.blobs,
              timeline,
              cache: imageCache,
            })
          } catch (err) {
            storageFailure = { value: err }
          }
        }
        // 校验期间被中止：与拉取期间中止同一处置，一条不写
        if (cfg.signal?.aborted) continue
        if (problem !== undefined) {
          // 返回值不合规是确定性的宿主代码错误（或失效的图片引用）：fail-closed，以 error 收口（中途已有半个 run 的日志，回放看得见断在哪）
          const { events, result } = await fail({
            category: "input",
            message: problem,
            retryable: false,
            detail: { phase: "pullInput" },
          })
          yield* events
          return result
        }
        if (storageFailure !== undefined) {
          // 与回调抛错同一口径：这一批当没拉到，宿主没见到写入事件就不认领，下一空档再拉
          const errors = await hostFailure(
            `reading a blob referenced by pulled input failed: ${describeThrown(storageFailure.value)}`,
          )
          yield* errors
          timeline = [...timeline, ...errors]
        } else if (pulled.length > 0) {
          const written = await append(pulled)
          yield* written
          // 整体重绑：本轮后面的投影、ctx.timeline、executeToolCalls 的拼接都要看到拉进来的事件
          timeline = [...timeline, ...written]
        }
      }
    }
    // 上一次模型请求的真实用量：日志最后一条 budget_usage（续跑时上次 run 的也算）。感知用它校准估算，预算用它算上下文大小
    const lastUsage = lastBudgetUsage(timeline)?.payload.tokens

    // 投影：模型本轮看什么。策略新造的事件（阈值 compaction）先入日志 —— 模型可见 ⟺ 已记录
    const projected = project({
      timeline,
      budget: {
        contextLimit: capabilities.contextWindow,
        ...(cfg.projection?.reserveTokens !== undefined
          ? { reserveTokens: cfg.projection.reserveTokens }
          : {}),
      },
      registry,
      sessionId,
      now: turnStartedAt,
      newId,
      ...(cfg.projection?.strategies ? { strategies: cfg.projection.strategies } : {}),
      ...(cfg.projection?.estimate ? { estimate: cfg.projection.estimate } : {}),
    })
    if (projected.emitted.length > 0) {
      await log.append(projected.emitted)
      lastSeq += projected.emitted.length
      yield* projected.emitted
    }

    const emitted: EventDraft[] = []
    // 本批工具活动：同一个对象随落随更，Socket 经 ctx.batch 只读
    const batch: MutableToolBatch = { calls: [], results: [], held: [], resumed: false }
    const ctx: TurnContext = {
      session: { id: sessionId, turn: turns + 1 },
      ...(cfg.principal ? { principal: cfg.principal } : {}),
      events: projected.events,
      timeline,
      log,
      ...(cfg.blobs ? { blobs: cfg.blobs } : {}),
      ...(cfg.memory ? { memory: cfg.memory } : {}),
      tools: baseTools,
      model,
      capabilities,
      budget: {
        contextLimit: capabilities.contextWindow,
        targetTokens: projected.stats.targetTokens,
        used: projected.stats.estimatedTokens,
        tokensSpent,
        turns,
        toolCalls: toolCallsTotal,
        wallMs: turnStartedAt - startedAt,
        ...(lastUsage ? { lastUsage } : {}),
      },
      ...(cfg.signal ? { signal: cfg.signal } : {}),
      batch,
      emit: (d) => emitted.push(d),
    }
    const flush = async (): Promise<Event[]> => {
      const events = await append(emitted.splice(0))
      return events
    }

    // ---- 先补齐日志里没结果的 tool_call（上次暂停 / 崩溃留下的），再问模型 ----
    const pending = pendingToolCalls(timeline)
    if (pending.length > 0) {
      // 补跑：本批 = 遗留调用所在那批（含上次已落的结果），Socket 据 resumed 分辨"没有新的模型输出"
      const located = toolBatchOf(timeline, pending)
      batch.calls.push(...located.calls)
      batch.results.push(...located.results)
      batch.resumed = true
      const settled = yield* executeToolCalls(ctx, pending, timeline, {
        cfg,
        sockets,
        append,
        flush,
        forwardedDecisions,
        spend: spendInto(ctx),
        batch,
        imageCache,
      })
      toolCallsTotal += settled.executed
      // 用户停止、或其它中止（断线、丢租约）落在批中途时不进 onTurnEnd：余下的调用还 pending，
      // Socket 判出 handoff / done 就会把它们带进一个不是 paused 的结局
      if (settled.interruptions.length > 0 || isStopped(cfg.signal) || abortedMidBatch(cfg.signal, batch)) {
        const interruptions = withBatchAbortNote(settled.interruptions)
        const { events, result } = await pause(pauseReasonOf(interruptions), interruptions)
        yield* events
        return result
      }
      // 被打断的那一轮（上次 run 的模型输出 + 这次补齐的结果）到此才算结束：让 Socket 收尾（如 handoff 模块按日志重建交接意图）。
      // 都无意见则继续：结果已入日志，重读时间线让模型看到（若宿主已中止，下一轮开头就会暂停）
      const ended = yield* endTurn(ctx, "continue", flush)
      if (ended) return ended
      continue
    }
    if (turns >= maxTurns) {
      const note = `reached the per-run turn limit of ${maxTurns}`
      const { events, result } = await pause("budget", [{ kind: "budget", note, code: MAX_TURNS_PAUSE_CODE }])
      yield* events
      return result
    }
    turns++
    ctx.session.turn = turns
    ctx.budget.turns = turns

    // ---- beforeModel：脑子改投影、增删工具、注入 system_note。补丁顺序合并：后一个 Socket 看到前一个改过的 ----
    let visible = ctx.events
    let tools = baseTools
    let systemPrompt = baseSystemPrompt
    /** 只向厂商声明、不载入上下文的工具名（L1）：后一个 Socket 给了就整体替换 */
    let deferredTools: ReadonlySet<string> = new Set()
    for (const s of sockets) {
      const patch = await s.beforeModel?.(ctx)
      if (!patch) continue
      if (patch.events) visible = patch.events
      if (patch.tools) tools = patch.tools
      if (patch.systemPrompt !== undefined) systemPrompt = patch.systemPrompt
      if (patch.deferredTools) deferredTools = new Set(patch.deferredTools)
      ctx.events = visible
      ctx.tools = tools
    }
    // 钩子期间 emit 的草稿：入日志，且本轮就让模型看到（运维类型与 ext.* 除外，与投影同一口径）
    const injected = await flush()
    yield* injected
    visible = [...visible, ...injected.filter((e) => !isModelInvisibleByDefault(e.type))]
    ctx.events = visible
    ctx.tools = tools
    // 进 budget_usage.contextEstimate 的估算取真正送出的视图（补丁改过、注入追加后），不是投影那一刻的：
    // contextOverheadOf 拿"真实 − 它"当固定开销，本轮注入的说明 / 快照若漏算，就被当成开销、下一轮再随时间线估一遍，
    // 感知、到线请求与阈值兜底一起高估（全库审查 2026-11-25 #20）。ctx.budget.used 仍是投影估算（beforeModel 时的读数）
    const sentEstimate = estimateTotal(visible, cfg.projection?.estimate ?? roughTokenEstimate)

    // ---- 问模型（瞬断有限重试，见 retry.ts）----
    // 每次尝试重新 toRequest + stream；beforeModel 钩子不重跑（视图、工具、说明都是本轮已定的）。
    // 只有本次尝试一块模型输出都没落日志时才重试：落了半截再重说，日志里就有两份半截。
    let outcome: LoweringOutcome | undefined
    const modelEvents: Event[] = []
    /**
     * 本轮视图里的图片引用换回内联（媒体引用方案）：只给 toRequest，不回写 ctx.events（Socket 与估算仍看引用）。
     * 成功一次后瞬断重试复用同一份；存储故障（非 not_found）在 try 里抛出，走模型调用失败与重试判定
     */
    let hydrated: Event[] | undefined
    /** 本会话已用过的 toolCallId：模型新给的调用 id 与它们撞了（或为空）就改写，见 withUniqueToolCallId */
    const usedCallIds = toolCallIdsOf(timeline)
    for (let attempt = 1; ; attempt++) {
      let failure: ModelCallFailure | undefined
      let attemptOutput = 0
      try {
        hydrated ??= await hydrateImageRefs(visible, { blobs: cfg.blobs, cache: imageCache })
        const request = lowering.toRequest({
          events: hydrated,
          tools: tools.map((t) => deferredToolSpecOf(t, deferredTools.has(t.name))),
          model,
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        })
        cfg.onLandings?.(lossesOf(request), request)
        const streamCtx: LoweringStreamContext = {
          ...(cfg.signal ? { signal: cfg.signal } : {}),
          ...(cfg.onDelta ? { onDelta: cfg.onDelta } : {}),
        }
        const stream = lowering.stream(request, streamCtx)
        while (true) {
          const step = await stream.next()
          if (step.done) {
            outcome = step.value
            break
          }
          // 模型说的每一块立刻入日志，宿主随即拿到
          const appended = await append([withUniqueToolCallId(step.value, usedCallIds, () => newId(now()))])
          modelEvents.push(...appended)
          attemptOutput += appended.length
          yield* appended
        }
      } catch (err) {
        // 降级层异常：缺 key、翻译不出合法请求（不重试），或网络断开（重试）
        failure = { kind: "thrown", error: err }
      }
      if (outcome) {
        // 失败的尝试也花了 token（缓存读、被掐前的输入），一并记账
        tokensSpent += outcome.usage.input + outcome.usage.output
        ctx.budget.tokensSpent = tokensSpent
        ctx.budget.lastUsage = outcome.usage
        if (outcome.stopReason === "error")
          failure = { kind: "outcome", message: outcome.errorMessage ?? "model response failed" }
      }
      ctx.budget.wallMs = now() - startedAt
      if (!failure) break

      const transient = retry.isTransient(failure)
      const canRetry = transient && attemptOutput === 0 && attempt < retry.maxAttempts && !cfg.signal?.aborted
      const base =
        failure.kind === "thrown"
          ? {
              category: "lowering",
              message: errorMessageOf(failure.error),
              detail: { name: (failure.error as { name?: string } | null)?.name ?? "Error" } as Record<
                string,
                unknown
              >,
            }
          : {
              category: "provider",
              message: failure.message,
              detail: { usage: outcome?.usage } as Record<string, unknown>,
            }
      // 宿主中止导致的失败（连接阶段被掐：fetch 抛出的是 signal.reason，不一定是 AbortError）是暂停不是错误
      if (!canRetry && cfg.signal?.aborted) {
        // 抛错前已落日志的调用来自一次没说完的响应，与下面 aborted 出口同样收尾后再暂停
        const dropped = await append(droppedCallResults(modelEvents, cfg.signal))
        const { events, result } = await pause("host", [
          { kind: "host", note: "host aborted the model request" },
        ])
        yield* dropped
        yield* events
        return result
      }
      if (!canRetry) {
        // 这次响应里已落日志的调用一并收尾成"没执行"（与停止收尾同一形状）：error 结局不能带着 pending，
        // 否则下一个 run 在用户的新话之后、模型读到它之前就先补跑一条可能入参截断的调用
        const dropped = notExecutedResults(modelEvents, MODEL_FAILED_NOT_EXECUTED_TEXT)
        const { events, result } = await fail(
          {
            ...base,
            retryable: transient,
            detail: {
              ...base.detail,
              attempts: attempt,
              ...(attemptOutput > 0 ? { partialOutput: attemptOutput } : {}),
            },
          },
          dropped,
        )
        yield* events
        return result
      }
      const delayMs = retry.delayFor(attempt)
      // 将要重试的失败也进日志：宿主与 eval 看得见发生过什么，模型看不见（运维事件）
      yield* await append([
        {
          type: "core.error",
          actor: "system",
          payload: {
            ...base,
            retryable: true,
            detail: { ...base.detail, attempts: attempt, willRetry: true, delayMs },
          },
        },
      ])
      outcome = undefined
      await retry.sleep(delayMs, cfg.signal)
      if (cfg.signal?.aborted) {
        const { events, result } = await pause("host", [
          { kind: "host", note: "host aborted while waiting to retry" },
        ])
        yield* events
        return result
      }
    }
    if (!outcome)
      throw new Error("runLoop internal error: the model call produced neither an outcome nor a failure")

    for (const e of modelEvents) if (e.type === "core.tool_call") batch.calls.push(e as ToolCallEvent)
    for (const s of sockets) await s.afterModel?.(ctx, modelEvents)
    yield* await flush()

    if (outcome.stopReason === "aborted") {
      // 这次响应没说完：降级层可能按已累积的半截入参吐出 tool_call（不保证是完整的块），所以这些调用一律收尾成"没执行"
      // 再暂停、不进 onTurnEnd，不留作 pending——否则下一个 run 在用户的新话之后、模型读到它之前就先补跑
      const dropped = await append(droppedCallResults(modelEvents, cfg.signal))
      const { events, result } = await pause("host", [
        { kind: "host", note: "host aborted the model response" },
      ])
      yield* dropped
      yield* events
      return result
    }

    // ---- 执行工具 ----
    const calls = modelEvents.filter((e): e is ToolCallEvent => e.type === "core.tool_call")
    let interruptions: Interruption[] = []
    if (calls.length > 0) {
      const settled = yield* executeToolCalls(ctx, calls, [...timeline, ...injected, ...modelEvents], {
        cfg,
        sockets,
        append,
        flush,
        forwardedDecisions,
        spend: spendInto(ctx),
        batch,
        imageCache,
      })
      toolCallsTotal += settled.executed
      ctx.budget.toolCalls = toolCallsTotal
      interruptions = settled.interruptions
    }

    yield* await append([
      {
        type: "core.budget_usage",
        actor: "system",
        payload: {
          tokens: outcome.usage,
          toolCalls: calls.length,
          wallMs: now() - turnStartedAt,
          contextEstimate: sentEstimate,
        },
      },
    ])

    // 用户停止或其它中止在工具批中途：余下调用还 pending，同样不进 onTurnEnd（见续跑处）
    if (
      interruptions.length > 0 ||
      (calls.length > 0 && isStopped(cfg.signal)) ||
      abortedMidBatch(cfg.signal, batch)
    ) {
      interruptions = withBatchAbortNote(interruptions)
      const { events, result } = await pause(pauseReasonOf(interruptions), interruptions)
      yield* events
      return result
    }

    // ---- 本轮结束：第一个给出意见的 Socket 决定；都无意见时按有没有工具调用 ----
    const ended = yield* endTurn(ctx, calls.length > 0 ? "continue" : "stop", flush)
    if (ended) return ended
  }

  /**
   * 一轮的收尾：问 onTurnEnd（第一个给意见的定）、落下钩子留的痕，按决定收口。
   * 返回 RunResult 即整个 run 到此结束；返回 undefined 即继续下一轮。
   * 正常路径在模型输出与工具都处理完之后调；续跑补齐 pending 之后也调 —— 被审批 / 中止打断的那一轮到那时才算结束，
   * 否则它永远没有 onTurnEnd，模块在那一轮记下的决定（如 handoff 的交接意图）就丢了（R2）。
   */
  async function* endTurn(
    ctx: TurnContext,
    fallback: TurnDecision,
    flush: () => Promise<Event[]>,
  ): AsyncGenerator<Event, RunResult | undefined> {
    // 工具批跑完才到这里：墙钟刷新到此刻，onTurnEnd（budget 的 wallMs 上限）看得见本轮工具耗时，
    // 否则慢工具要到下一轮模型调用后才计入、上限多放一整轮（全库审查 2026-11-25 #24）
    ctx.budget.wallMs = now() - startedAt
    let decision: TurnDecision = fallback
    for (const s of sockets) {
      const d = await s.onTurnEnd?.(ctx)
      if (d !== undefined) {
        decision = d
        break
      }
    }
    yield* await flush()

    if (decision === "continue") return undefined
    if (decision === "stop") {
      // 终结记号：跑完了。RunResult.lastSeq 包含这一条
      yield* await append([{ type: "core.run_ended", actor: "system", payload: { status: "done" } }])
      return { status: "done", sessionId, lastSeq }
    }
    if ("pause" in decision) {
      // Socket 要求暂停就一定暂停：意见里不合规的地方（原因码格式、reason 不在闭集）由 resolveSocketPause 改正，
      // 改正处记一条模型不可见的非终结 core.error——标注写错不能把受控暂停变成 error、丢掉续跑凭据，也不静默
      const { interruption, error } = resolveSocketPause(decision.pause)
      if (error !== undefined) {
        yield* await append([{ type: "core.error", actor: "system", payload: error }])
      }
      const { events, result } = await pause(interruption.kind, [interruption])
      yield* events
      return result
    }

    // ---- 交接：旧会话记 handoff，新会话开头 = 摘要说明 + 脑子带来的开场事件（如 pin）+ 触发消息 ----
    const intent = decision.handoff
    const toSessionId = intent.toSessionId ?? newId(now())
    const handoffEvents = await append([
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
    yield* handoffEvents
    const at = now()
    // 发起者如实记（#52）：触发消息要对照旧会话完整时间线判是不是用户的原话
    const opening = handoffOpeningDrafts(
      intent,
      handoffEvents[0] as Event,
      await readTimeline(log, sessionId, { registry }),
    )
    const openingEvents = opening.map((d, i) =>
      createEvent(registry, { ...d, sessionId: toSessionId, seq: i + 1, at, id: newId(at) }),
    )
    // 开场写进新会话但不 yield（#55）：runLoop 只产出本会话的事件，消费方（server 的 SSE / onEvent、AG-UI 线程）
    // 都按"事件属于 sessionId"处理，混进别的会话会让 SSE id 倒退、前端旧线程多出消息、观测记错会话。
    // 新会话的开场经 RunResult.toSessionId 从日志读
    await log.append(openingEvents)
    // 新会话开场写成之后才在旧会话落终结记号：开场写失败时 run 抛错，旧会话判 interrupted，与"交接没完成"一致
    yield* await append([
      { type: "core.run_ended", actor: "system", payload: { status: "handoff", toSessionId } },
    ])
    await cfg.onHandoff?.(sessionId, toSessionId)
    return { status: "handoff", sessionId, lastSeq, toSessionId }
  }
}

/**
 * 中止（任何原因）落在工具批中途：signal 已中止且本批还有调用没落结果（全库审查 2026-11-25 #11）。
 * executeToolCalls 见到中止只 break、不推中断，余下调用留作 pending；此时再进 onTurnEnd，Socket 判出 handoff / stop
 * 就会带着 pending 以非 paused 结局收场（旧会话留一条过期的写调用等人重放）。用户停止由 isStopped 那支另判
 */
function abortedMidBatch(signal: AbortSignal | undefined, batch: MutableToolBatch): boolean {
  if (!signal?.aborted) return false
  const answered = new Set(batch.results.map((r) => r.payload.toolCallId))
  return batch.calls.some((c) => !answered.has(c.payload.toolCallId))
}

/**
 * 一次没说完的模型响应里已落日志的 tool_call → 同形状的"没执行"收尾结果（isError，不执行）。
 * 模型失败（error 结局）与宿主中止（paused 结局）共用；只管形状，文案由调用方定
 */
function notExecutedResults(modelEvents: readonly Event[], text: string): ToolResultDraft[] {
  return modelEvents
    .filter((e): e is ToolCallEvent => e.type === "core.tool_call")
    .map(
      (call): ToolResultDraft => ({
        type: "core.tool_result",
        actor: "tool",
        parentId: call.id,
        provenance: { source: call.payload.name },
        payload: {
          toolCallId: call.payload.toolCallId,
          name: call.payload.name,
          content: [{ type: "text", text }],
          isError: true,
        },
      }),
    )
}

/**
 * 宿主中止模型响应时要先落的收尾结果。用户停止（RunStop）返回空：交给 pause() 的 settleStopped，
 * 文案随停止原因，与停止落在别处时一致
 */
function droppedCallResults(
  modelEvents: readonly Event[],
  signal: AbortSignal | undefined,
): ToolResultDraft[] {
  return isStopped(signal) ? [] : notExecutedResults(modelEvents, MODEL_INTERRUPTED_NOT_EXECUTED_TEXT)
}

/** 批中途被中止而没有别的中断时补一条宿主中断说明；已有中断（审批、客户端工具…）原样返回 */
function withBatchAbortNote(interruptions: Interruption[]): Interruption[] {
  return interruptions.length > 0
    ? interruptions
    : [{ kind: "host", note: "host aborted during the tool batch" }]
}

/** 时间线里全部 tool_call 的 toolCallId */
function toolCallIdsOf(timeline: readonly Event[]): Set<string> {
  const ids = new Set<string>()
  for (const raw of timeline) {
    const e = raw as CoreEvent
    if (e.type === "core.tool_call") ids.add(e.payload.toolCallId)
  }
  return ids
}

/**
 * 模型给的调用 id 在会话内必须唯一且非空（全库审查 2026-11-25 #50）：审批结论、tool_started、pending 与结果配对都按 toolCallId 认领，
 * 号池中转站或不合规的兼容端点按轮次编号（call_0）或干脆不给（Chat 线落空串）时，后一个调用会认领前一个的批准 / 拒绝 /
 * "已开始"，免审批执行或被误判。撞了就改写成 `reins_<newId>`、原值记进 `payload.meta.originalToolCallId`（不进模型上下文）；
 * 历史回放按改写后的 id 成对下发，厂商只要求同一请求里调用与结果对得上。不撞的草稿原样返回，并登记进 `used`。
 * 改写出的 id 规整成 `^[A-Za-z0-9_-]{1,64}$`（Anthropic tool_use id 的规矩，三家都收）：宿主自定义的 `newId` 可能带别的字符，
 * 不规整的话改写本身就会让每次回放 400。pi-ai Responses 的复合 id（`call_x|fc_y`）被改写后 fc_ 部分不再回放，只在撞 id 时发生
 */
function withUniqueToolCallId(draft: EventDraft, used: Set<string>, freshId: () => string): EventDraft {
  if (draft.type !== "core.tool_call") return draft
  const payload = draft.payload as ToolCallEvent["payload"]
  const original = payload.toolCallId
  if (typeof original === "string" && original.length > 0 && !used.has(original)) {
    used.add(original)
    return draft
  }
  // 规整与截断后仍撞（宿主 newId 前 58 字符恒定之类）就缀序号，保证必然结束
  const base = `reins_${freshId().replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64)
  let id = base
  for (let i = 2; used.has(id); i++) id = `${base.slice(0, 63 - String(i).length)}_${i}`
  used.add(id)
  return {
    ...draft,
    payload: { ...payload, toolCallId: id, meta: { ...payload.meta, originalToolCallId: original } },
  }
}

function pauseReasonOf(interruptions: readonly Interruption[]): PauseReason {
  // 审批优先：宿主最需要知道的是"有东西等人批"；子代理冒泡的按它自己的原因算
  const reasons = interruptions.map((i) =>
    i.kind === "subagent" ? i.reason : i.kind === "client_tool" ? "host" : i.kind,
  )
  if (reasons.includes("approval")) return "approval"
  if (reasons.includes("budget")) return "budget"
  return "host"
}

interface ExecuteDeps {
  cfg: LoopConfig
  sockets: readonly Socket[]
  append: (drafts: readonly EventDraft[]) => Promise<Event[]>
  flush: () => Promise<Event[]>
  /** 宿主给别的会话（子代理）的审批结论，原样进 ToolContext.decisions */
  forwardedDecisions: readonly ApprovalDecisionInput[]
  spend: (usage: TokenUsage) => void
  /** 本轮的 ctx.batch 本体：结果落日志后登记 results，挂起时登记 held */
  batch: MutableToolBatch
  /** run 级图片缓存：工具结果里的图片引用校验通过后字节放进去，下一轮换回直接用 */
  imageCache: ImageRefCache
}

/** ctx.batch 的可变本体（对外类型只读） */
interface MutableToolBatch {
  calls: ToolCallEvent[]
  results: ToolResultEvent[]
  held: string[]
  resumed: boolean
}

interface ExecuteSummary {
  /** 真正跑了 execute 的次数 */
  executed: number
  interruptions: Interruption[]
}

/** 日志里最后一条 budget_usage（最近一次模型请求的用量与估算） */
function lastBudgetUsage(timeline: readonly Event[]): CoreEventOf<"core.budget_usage"> | undefined {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]
    if (e?.type === "core.budget_usage") return e as CoreEventOf<"core.budget_usage">
  }
  return undefined
}

/** `{ trust }` 或空对象：exactOptionalPropertyTypes 下不能写 `trust: undefined` */
function withTrust(trust: Trust | undefined): { trust?: Trust } {
  return trust === undefined ? {} : { trust }
}

/**
 * 宿主回填的客户端工具结果（`input` 是 tool_result 草稿）也按工具声明落 trust：草稿自己带了 trust 就尊重（宿主直连循环时的显式选择；
 * 经 server 进来的草稿壳字段已被服务端重建、不含 trust），否则查工具表——与 execute 路径同一个 `toolResultTrust`
 */
function withResultTrust(input: EventDraft, tools: readonly Tool[]): EventDraft {
  if (input.type !== "core.tool_result" || input.trust !== undefined) return input
  const payload = input.payload as { name?: unknown; isError?: unknown } | null
  const tool = tools.find((t) => t.name === payload?.name)
  return { ...input, ...withTrust(toolResultTrust(tool, payload?.isError === true)) }
}

/**
 * 逐个处理工具调用：beforeTool → 审批判定 → 校验 → 执行 → afterTool → append tool_result。
 * 已有审批决定（timeline 里的 approval_decision）的调用按决定办；已有审批请求但没决定的不重复发请求。
 */
async function* executeToolCalls(
  ctx: TurnContext,
  calls: readonly ToolCallEvent[],
  timeline: readonly Event[],
  deps: ExecuteDeps,
): AsyncGenerator<Event, ExecuteSummary> {
  const { cfg, sockets, flush, forwardedDecisions, spend, batch, imageCache } = deps
  /** 落日志后把 tool_result 登记进 ctx.batch.results（审批请求等其它事件不登记）；不改 flush 语义 */
  const append = async (drafts: readonly EventDraft[]): Promise<Event[]> => {
    const events = await deps.append(drafts)
    for (const e of events) if (e.type === "core.tool_result") batch.results.push(e as ToolResultEvent)
    return events
  }
  const decisions = new Map<string, ApprovalDecisionPayload>()
  const requested = new Set<string>()
  /** 已开始动手的调用 → 开始时间（D2）：续跑时据它判"结果未知"并给文案缀时间，本批写下 started 也登记进来，避免重复写 */
  const started = toolStartedAt(timeline)
  for (const raw of timeline) {
    const e = raw as CoreEvent
    if (e.type === "core.approval_decision") decisions.set(e.payload.toolCallId, e.payload)
    if (e.type === "core.approval_request") requested.add(e.payload.toolCallId)
  }

  const summary: ExecuteSummary = { executed: 0, interruptions: [] }
  /** 先落工具与钩子留的痕（memory_op、approval_decision 等），再落这条结果 —— 每条结果路径都走这里，留痕永远排在结果前 */
  const settle = async (draft: EventDraft): Promise<Event[]> => [
    ...(await flush()),
    ...(await append([draft])),
  ]

  for (const call of calls) {
    const { toolCallId, name } = call.payload
    const tool = ctx.tools.find((t) => t.name === name)
    const errorResult = (text: string): ToolResultDraft => ({
      type: "core.tool_result",
      actor: "tool",
      parentId: call.id,
      provenance: { source: name },
      payload: { toolCallId, name, content: [{ type: "text", text }], isError: true },
    })

    // 中断不重放（D2）：开始动手后中断、没留下结果的不可重放调用，不再执行，落"结果未知"让模型先查再定。
    // 工具不在表里时判不出能不能重放，按不可重放处理（fail-closed）
    if (started.has(toolCallId) && (tool === undefined || !isReplayable(tool))) {
      yield* await settle(errorResult(outcomeUnknownText(tool, started.get(toolCallId))))
      continue
    }

    const decided = decisions.get(toolCallId)
    if (decided && !decided.approved) {
      yield* await append([errorResult(`Approval denied${decided.reason ? `: ${decided.reason}` : ""}`)])
      continue
    }

    // beforeTool：任一 block / defer 即定；rewrite 替换入参后继续问下一个 ——
    // 后续钩子看到的 call 带改写后的入参（策略判定的必须是真正要执行的那份，B7）；
    // 宿主已批准的调用再遇到 defer 不短路：批准只是"不用再问"，排在后面的钩子（如审批策略）仍有权拦。
    let args: unknown = call.payload.args
    let seen: ToolCallEvent = call
    let verdict: BeforeToolDecision = "proceed"
    for (const s of sockets) {
      const d = await s.beforeTool?.(ctx, seen, tool)
      if (d === undefined || d === "proceed") continue
      if ("rewrite" in d) {
        args = d.rewrite
        seen = { ...seen, payload: { ...seen.payload, args } }
        continue
      }
      if ("defer" in d && decided?.approved) continue
      verdict = d
      break
    }
    if (typeof verdict === "object" && "block" in verdict) {
      yield* await settle(errorResult(`Tool call blocked: ${verdict.block}`))
      continue
    }

    if (!tool) {
      yield* await settle(errorResult(`Unknown tool: ${name}`))
      continue
    }

    // 入参校验先于审批（R1）：needsApproval 与审批摘要看到的必须是将要执行的那份（校验 / 规范化之后），
    // 否则审批人批的与最终执行的不是同一份，needsApproval 的 TInput 类型也成了谎话。客户端工具同样先校验，入参不合法就不必等宿主
    try {
      if (tool.validate) args = tool.validate(args)
    } catch (err) {
      yield* await settle(errorResult(`Invalid arguments: ${errorMessageOf(err)}`))
      continue
    }

    const toolCtx: ToolContext = {
      sessionId: ctx.session.id,
      toolCallId,
      ...(ctx.principal ? { principal: ctx.principal } : {}),
      log: ctx.log,
      ...(ctx.blobs ? { blobs: ctx.blobs } : {}),
      ...(ctx.memory ? { memory: ctx.memory } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      emit: ctx.emit,
      ...(forwardedDecisions.length > 0 ? { decisions: forwardedDecisions } : {}),
      spend,
    }

    // 审批：Socket 说 defer，或工具自己声明 needsApproval 且尚无批准 —— 都转审批暂停
    let approval = typeof verdict === "object" && "defer" in verdict ? verdict.defer : undefined
    if (!approval && !decided?.approved && tool.needsApproval !== undefined) {
      // 谓词求值抛错按拒绝处理（全局范式：规则求值异常视为 deny）：落 isError、不执行，与 validate 抛错同一种收法。
      // 冒泡的话 run 不写终结事件，调用留作 pending，之后每个 run 补跑都撞同一个错
      let need: boolean
      try {
        need =
          typeof tool.needsApproval === "function"
            ? await tool.needsApproval(args, toolCtx)
            : tool.needsApproval
      } catch (err) {
        // 宿主那份记录：模型不可见的 core.error（与工具结果图片引用读库失败同一做法，经 emit 排在结果之前落下）
        ctx.emit({
          type: "core.error",
          actor: "system",
          payload: {
            category: "host",
            message: `needsApproval of ${name} threw: ${describeThrown(err)}`,
            retryable: false,
            detail: { phase: "needsApproval", toolCallId },
          },
        })
        yield* await settle(errorResult(`Approval check failed: ${errorMessageOf(err)}`))
        continue
      }
      if (need) {
        approval = { policyId: BUILTIN_APPROVAL_POLICY, summary: `${name}(${JSON.stringify(args) ?? ""})` }
      }
    }
    if (approval && !decided?.approved) {
      const request = { toolCallId, policyId: approval.policyId, summary: approval.summary }
      if (!requested.has(toolCallId)) {
        yield* await settle({
          type: "core.approval_request",
          actor: "system",
          parentId: call.id,
          payload: request,
        })
      }
      summary.interruptions.push({ kind: "approval", toolCallId, request, call: call.payload })
      batch.held.push(toolCallId)
      continue
    }

    // 客户端工具：本循环不执行，等宿主回填 tool_result 后续跑
    // `!tool.execute` 与 isClientTool 重复，只为让后面的 tool.execute 收窄
    if (isClientTool(tool) || !tool.execute) {
      summary.interruptions.push({ kind: "client_tool", toolCallId, call: call.payload })
      batch.held.push(toolCallId)
      continue
    }

    // 中止检查紧贴副作用之前：批尾那道检查拦不住"前一个调用转审批 / 被拦后 continue"与"模型回复收完、首个工具开跑前"两个空档。
    // 本调用留作 pending——用户停止由 pause() 收尾成"没执行"，其它中止恢复时补跑
    if (cfg.signal?.aborted) break

    // 不可重放的工具先记"开始动手"：execute 途中进程死亡，续跑见到它就不再执行（D2）
    const replayable = isReplayable(tool)
    const markStarted = async function* (): AsyncGenerator<Event, void> {
      if (started.has(toolCallId)) return
      yield* await flush()
      const [ev] = await append([
        { type: "core.tool_started", actor: "system", parentId: call.id, payload: { toolCallId } },
      ])
      if (ev) {
        started.set(toolCallId, ev.at)
        yield ev
      }
    }
    if (!replayable) yield* markStarted()

    let result: ToolResultDraft
    try {
      summary.executed++
      const out = await tool.execute(args, toolCtx)
      // 子代理暂停冒泡（§10.1）：不落 tool_result，这次调用留作 pending；父 run 整体暂停，宿主处理完子的中断后续跑父，
      // 补齐 pending 时工具再续跑子 run
      if (isSubagentPause(out)) {
        // 子代理已经动过手了：补写 started。不靠它防重放（asTool 可重放），而是让停止时认出"做了一半"、asTool 认出"父在补跑同一个调用"
        yield* markStarted()
        summary.interruptions.push({ kind: "subagent", toolCallId, call: call.payload, ...out.detail })
        batch.held.push(toolCallId)
        if (cfg.signal?.aborted) break
        continue
      }
      const normalized = tool.toModelOutput ? { content: tool.toModelOutput(out) } : normalizeToolOutput(out)
      result = {
        type: "core.tool_result",
        actor: "tool",
        parentId: call.id,
        provenance: { source: name },
        // 工具声明的结果 trust（如 skill_read 的 system）只用于成功结果；isError 结果与执行抛错仍是缺省 untrusted
        ...withTrust(toolResultTrust(tool, normalized.isError ?? false)),
        payload: { toolCallId, name, content: normalized.content, isError: normalized.isError ?? false },
      }
    } catch (err) {
      // 感知 signal 的不可重放工具被中止掐断（如 MCP 把 ctx.signal 传给 callTool）：写请求可能已经到了上游，落"结果未知"而不是"失败"
      result = errorResult(
        !replayable && cfg.signal?.aborted
          ? outcomeUnknownText(tool, started.get(toolCallId))
          : `Tool execution failed: ${errorMessageOf(err)}`,
      )
    }

    // afterTool：脑子可替换结果（外溢、截断），此时尚未 append
    for (const s of sockets) {
      const replaced = await s.afterTool?.(ctx, call, result)
      if (replaced) result = replaced
    }
    // 图片引用校验放在最后一个能改结果的地方之后（媒体引用方案）：toModelOutput 输出、afterTool 换掉的结果、isError 结果都覆盖到。
    // 只换掉不合规的那几段、其余照留：写工具已经动过手，整条换成"not found"会让模型以为没做成再做一遍；
    // recall 取回的旧消息里图已被清理时，文字也不该跟着丢（2026-11-24 独立审查）
    const refs = await checkToolResultRefs(result.payload.content, {
      sessionId: ctx.session.id,
      blobs: ctx.blobs,
      timeline,
      cache: imageCache,
    })
    if (refs.content !== result.payload.content)
      result = { ...result, payload: { ...result.payload, content: refs.content } }
    // 存储故障的原因记一条模型不可见的 core.error（经 settle 的 flush 排在结果之前），模型只看到"读不出来"
    for (const failure of refs.storageFailures) ctx.emit(failure)
    yield* await settle(result)
    // 宿主中止：本条结果已落，余下的调用不再执行、留作 pending；循环下一轮开头据 signal 直接 paused(host)
    if (cfg.signal?.aborted) break
  }
  return summary
}

/**
 * 工具结果里的图片引用逐段校验：合规的原样留；不合规的那段换成统一的 "not found" 那句文本；校验时存储自己抛错的换成
 * "Could not read blob <id>: storage error"（不说 not found，免得模型以为图没了），原因另给一条模型不可见的 core.error 草稿。
 * 没有要换的段时返回同一个 content 数组。
 * 整条结果的引用先一次并发预读，再逐段只用落定表判——同一张图出现两次且读取瞬断时只读一次、两段都回 storage error
 */
async function checkToolResultRefs(
  parts: ContentPart[],
  ctx: CheckImageRefsContext,
): Promise<{ content: ContentPart[]; storageFailures: EventDraft[] }> {
  if (!parts.some(isImageRef)) return { content: parts, storageFailures: [] }
  const reads = await prefetchImageRefs(parts, ctx)
  const storageFailures: EventDraft[] = []
  let changed = false
  const content: ContentPart[] = []
  for (const p of parts) {
    if (!isImageRef(p)) {
      content.push(p)
      continue
    }
    let text: string | undefined
    try {
      text = judgeImageRef(p, ctx, reads)
    } catch (err) {
      text = `Could not read blob ${p.blobId}: storage error`
      storageFailures.push({
        type: "core.error",
        actor: "system",
        payload: {
          category: "host",
          message: `reading blob ${p.blobId} referenced by a tool result failed: ${describeThrown(err)}`,
          retryable: true,
          detail: { phase: "toolResult" },
        },
      })
    }
    if (text === undefined) content.push(p)
    else {
      changed = true
      content.push({ type: "text", text })
    }
  }
  return { content: changed ? content : parts, storageFailures }
}
