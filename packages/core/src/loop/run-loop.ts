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
import type { ContentPart, Event } from "../events/base.js"
import type { ApprovalDecisionPayload, CoreEvent, CoreEventOf, ErrorPayload } from "../events/core.js"
import { createEvent, type EventDraft } from "../events/create.js"
import { uuidv7 } from "../events/id.js"
import { createCoreRegistry } from "../events/registry.js"
import { type LoweringOutcome, type LoweringStreamContext, lossesOf } from "../lowering/types.js"
import { DEFAULT_MODEL_INVISIBLE_TYPES } from "../projection/filter.js"
import { project } from "../projection/project.js"
import { readTimeline } from "../store/read-timeline.js"
import {
  computeConfigHash,
  pendingToolCalls,
  RunStateError,
  serializeRunState,
  validateResume,
} from "./state.js"
import { resolveSocketContributions } from "./static.js"
import { errorMessageOf, normalizeToolOutput, toolSpecOf } from "./tools.js"
import type {
  BeforeToolDecision,
  Interruption,
  LoopConfig,
  PauseReason,
  RunResult,
  Socket,
  ToolCallEvent,
  ToolContext,
  ToolResultDraft,
  TurnContext,
  TurnDecision,
} from "./types.js"

export const DEFAULT_MAX_TURNS = 100

/** 循环内置的审批策略标识：工具自己声明 needsApproval 且没有 Socket 做主 */
export const BUILTIN_APPROVAL_POLICY = "tool.needsApproval"

function inputDraft(input: NonNullable<LoopConfig["input"]>): EventDraft {
  if (typeof input === "string")
    return { type: "core.user_message", actor: "user", payload: { content: [{ type: "text", text: input }] } }
  if (Array.isArray(input))
    return { type: "core.user_message", actor: "user", payload: { content: input as ContentPart[] } }
  return input
}

export async function* runLoop(cfg: LoopConfig): AsyncGenerator<Event, RunResult> {
  const { sessionId, log, lowering, model } = cfg
  const registry = cfg.registry ?? createCoreRegistry()
  const now = cfg.now ?? (() => Date.now())
  const newId = cfg.newId ?? uuidv7
  const sockets = cfg.sockets ?? []
  // Socket 的静态贡献在这里并入：工具表与系统提示整个 run 不变（prompt cache），续跑补齐 pending 时也在场。
  // 算法在 static.ts，server 的恢复预校验用同一份，configHash 才对得上
  const { tools: baseTools, systemPrompt: baseSystemPrompt } = resolveSocketContributions(cfg)
  const maxTurns = cfg.maxTurns ?? DEFAULT_MAX_TURNS
  const capabilities = lowering.capabilities(model)
  const configHash = await computeConfigHash({
    model,
    tools: baseTools,
    ...(baseSystemPrompt !== undefined ? { systemPrompt: baseSystemPrompt } : {}),
  })

  const startedAt = now()
  // 起步先把整条日志过一遍注册表：有读不出来的事件（未登记的 ext.*、未来版本）就在写任何东西之前拒绝（P9 fail-closed）
  let lastSeq = (await readTimeline(log, sessionId, { registry })).at(-1)?.seq ?? 0
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

  const pause = async (
    reason: PauseReason,
    interruptions: Interruption[],
  ): Promise<{ events: Event[]; result: RunResult }> => {
    const events = await append([{ type: "core.run_paused", actor: "system", payload: { reason } }])
    // pending 以日志为准（而不是本轮内存里的列表），恢复时对账的也是日志
    const pending = pendingToolCalls(await readTimeline(log, sessionId, { registry }))
    const state = await serializeRunState({
      sessionId,
      lastSeq,
      pending,
      configHash,
      ...(cfg.secret !== undefined ? { secret: cfg.secret } : {}),
    })
    return { events, result: { status: "paused", sessionId, lastSeq, reason, interruptions, state } }
  }

  const fail = async (payload: ErrorPayload): Promise<{ events: Event[]; result: RunResult }> => {
    const events = await append([{ type: "core.error", actor: "system", payload }])
    const error = events[0] as CoreEventOf<"core.error">
    return { events, result: { status: "error", sessionId, lastSeq, error } }
  }

  // ---- 恢复与审批结论：先做完全部校验（不通过就抛，一条日志都不写），再写 run_resumed 与 approval_decision ----
  if (cfg.resume !== undefined || (cfg.decisions && cfg.decisions.length > 0)) {
    const timeline = await readTimeline(log, sessionId, { registry })
    if (cfg.resume !== undefined) {
      await validateResume({
        state: cfg.resume,
        sessionId,
        timeline,
        configHash,
        ...(cfg.secret !== undefined ? { secret: cfg.secret } : {}),
        ...(cfg.allowConfigDrift !== undefined ? { allowConfigDrift: cfg.allowConfigDrift } : {}),
      })
    }
    const decisions = cfg.decisions ?? []
    const pendingIds = new Set(pendingToolCalls(timeline).map((c) => c.payload.toolCallId))
    for (const d of decisions) {
      if (!pendingIds.has(d.toolCallId)) {
        throw new RunStateError("unknown_tool_call", `审批结论指向的调用 ${d.toolCallId} 并不在等待中`, {
          toolCallId: d.toolCallId,
        })
      }
    }
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
  if (cfg.input !== undefined) yield* await append([inputDraft(cfg.input)])

  while (true) {
    const turnStartedAt = now()
    const timeline = await readTimeline(log, sessionId, { registry })
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
      emit: (d) => emitted.push(d),
    }
    const flush = async (): Promise<Event[]> => {
      const events = await append(emitted.splice(0))
      return events
    }

    // ---- 先补齐日志里没结果的 tool_call（上次暂停 / 崩溃留下的），再问模型 ----
    const pending = pendingToolCalls(timeline)
    if (pending.length > 0) {
      const settled = yield* executeToolCalls(ctx, pending, timeline, { cfg, sockets, append, flush })
      toolCallsTotal += settled.executed
      if (settled.interruptions.length > 0) {
        const reason = pauseReasonOf(settled.interruptions)
        const { events, result } = await pause(reason, settled.interruptions)
        yield* events
        return result
      }
      continue // 结果已入日志，重读时间线让模型看到
    }

    if (cfg.signal?.aborted) {
      const { events, result } = await pause("host", [{ kind: "host", note: "宿主在本轮开始前中止" }])
      yield* events
      return result
    }
    if (turns >= maxTurns) {
      const note = `单次 run 轮数达到上限 ${maxTurns}`
      const { events, result } = await pause("budget", [{ kind: "budget", note }])
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
    for (const s of sockets) {
      const patch = await s.beforeModel?.(ctx)
      if (!patch) continue
      if (patch.events) visible = patch.events
      if (patch.tools) tools = patch.tools
      if (patch.systemPrompt !== undefined) systemPrompt = patch.systemPrompt
      ctx.events = visible
      ctx.tools = tools
    }
    // 钩子期间 emit 的草稿：入日志，且本轮就让模型看到（运维类型除外）
    const injected = await flush()
    yield* injected
    visible = [...visible, ...injected.filter((e) => !DEFAULT_MODEL_INVISIBLE_TYPES.has(e.type))]
    ctx.events = visible
    ctx.tools = tools

    // ---- 问模型 ----
    let outcome: LoweringOutcome
    const modelEvents: Event[] = []
    try {
      const request = lowering.toRequest({
        events: visible,
        tools: tools.map(toolSpecOf),
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
        const appended = await append([step.value])
        modelEvents.push(...appended)
        yield* appended
      }
    } catch (err) {
      // 降级层异常（缺 key、翻译不出合法请求、网络断开）：记 error 事件，交宿主决定重试
      const { events, result } = await fail({
        category: "lowering",
        message: errorMessageOf(err),
        retryable: false,
        detail: { name: (err as { name?: string }).name ?? "Error" },
      })
      yield* events
      return result
    }
    tokensSpent += outcome.usage.input + outcome.usage.output
    ctx.budget.tokensSpent = tokensSpent
    ctx.budget.wallMs = now() - startedAt
    ctx.budget.lastUsage = outcome.usage

    if (outcome.stopReason === "error") {
      const { events, result } = await fail({
        category: "provider",
        message: outcome.errorMessage ?? "模型响应出错",
        retryable: false,
        detail: { usage: outcome.usage },
      })
      yield* events
      return result
    }

    for (const s of sockets) await s.afterModel?.(ctx, modelEvents)
    yield* await flush()

    if (outcome.stopReason === "aborted") {
      // 已完整的内容块都入了日志；未回答的 tool_call 留给恢复时补齐
      const { events, result } = await pause("host", [{ kind: "host", note: "宿主中止了模型响应" }])
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
          contextEstimate: projected.stats.estimatedTokens,
        },
      },
    ])

    if (interruptions.length > 0) {
      const { events, result } = await pause(pauseReasonOf(interruptions), interruptions)
      yield* events
      return result
    }

    // ---- 本轮结束：第一个给出意见的 Socket 决定；都无意见时按有没有工具调用 ----
    let decision: TurnDecision = calls.length > 0 ? "continue" : "stop"
    for (const s of sockets) {
      const d = await s.onTurnEnd?.(ctx)
      if (d !== undefined) {
        decision = d
        break
      }
    }
    yield* await flush()

    if (decision === "continue") continue
    if (decision === "stop") return { status: "done", sessionId, lastSeq }
    if ("pause" in decision) {
      const note = decision.pause.note ?? `Socket 要求暂停（${decision.pause.reason}）`
      const kind = decision.pause.reason
      const { events, result } = await pause(kind, [{ kind, note }])
      yield* events
      return result
    }

    // ---- 交接：旧会话记 handoff，新会话开头 = 摘要说明 + 脑子带来的开场事件（如 pin）+ 触发消息 ----
    const intent = decision.handoff
    const toSessionId = intent.toSessionId ?? newId(now())
    yield* await append([
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
    if (intent.triggerMessage !== undefined) {
      opening.push({
        type: "core.user_message",
        actor: "user",
        payload: { content: [{ type: "text", text: intent.triggerMessage }] },
      })
    }
    const openingEvents = opening.map((d, i) =>
      createEvent(registry, { ...d, sessionId: toSessionId, seq: i + 1, at, id: newId(at) }),
    )
    await log.append(openingEvents)
    yield* openingEvents
    await cfg.onHandoff?.(sessionId, toSessionId)
    return { status: "handoff", sessionId, lastSeq, toSessionId }
  }
}

function pauseReasonOf(interruptions: readonly Interruption[]): PauseReason {
  // 审批优先：宿主最需要知道的是"有东西等人批"
  if (interruptions.some((i) => i.kind === "approval")) return "approval"
  if (interruptions.some((i) => i.kind === "budget")) return "budget"
  return "host"
}

interface ExecuteDeps {
  cfg: LoopConfig
  sockets: readonly Socket[]
  append: (drafts: readonly EventDraft[]) => Promise<Event[]>
  flush: () => Promise<Event[]>
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
  const { cfg, sockets, append, flush } = deps
  const decisions = new Map<string, ApprovalDecisionPayload>()
  const requested = new Set<string>()
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

    const decided = decisions.get(toolCallId)
    if (decided && !decided.approved) {
      yield* await append([errorResult(`审批被拒绝${decided.reason ? `：${decided.reason}` : ""}`)])
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
      yield* await settle(errorResult(`工具调用被拦截：${verdict.block}`))
      continue
    }

    if (!tool) {
      yield* await settle(errorResult(`未知工具：${name}`))
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
    }

    // 审批：Socket 说 defer，或工具自己声明 needsApproval 且尚无批准 —— 都转审批暂停
    let approval = typeof verdict === "object" && "defer" in verdict ? verdict.defer : undefined
    if (!approval && !decided?.approved && tool.needsApproval !== undefined) {
      const need =
        typeof tool.needsApproval === "function"
          ? await tool.needsApproval(args, toolCtx)
          : tool.needsApproval
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
      continue
    }

    // 客户端工具：本循环不执行，等宿主回填 tool_result 后续跑
    if (!tool.execute || tool.side === "client") {
      summary.interruptions.push({ kind: "client_tool", toolCallId, call: call.payload })
      continue
    }

    let result: ToolResultDraft
    try {
      if (tool.validate) args = tool.validate(args)
    } catch (err) {
      yield* await settle(errorResult(`入参不合法：${errorMessageOf(err)}`))
      continue
    }
    try {
      summary.executed++
      const out = await tool.execute(args, toolCtx)
      const normalized = tool.toModelOutput ? { content: tool.toModelOutput(out) } : normalizeToolOutput(out)
      result = {
        type: "core.tool_result",
        actor: "tool",
        parentId: call.id,
        provenance: { source: name },
        payload: { toolCallId, name, content: normalized.content, isError: normalized.isError ?? false },
      }
    } catch (err) {
      result = errorResult(`工具执行失败：${errorMessageOf(err)}`)
    }

    // afterTool：脑子可替换结果（外溢、截断），此时尚未 append
    for (const s of sockets) {
      const replaced = await s.afterTool?.(ctx, call, result)
      if (replaced) result = replaced
    }
    yield* await settle(result)
    if (cfg.signal?.aborted) break
  }
  return summary
}
