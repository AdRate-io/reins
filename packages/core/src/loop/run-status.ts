/**
 * 会话运行状态（AdRate 建议 11 / 12）：从"租约 + 最后一条 run 标记"判一个会话此刻处于什么状态。
 *
 * 结局在时间线上（宪法二）：runLoop 让每个 run 以 tools_bound(marksEnd) 开头、以恰好一条终结事件收尾
 * （暂停是 run_paused，其余是 run_ended）。所以会话的状态只看两样：
 * - 租约是否持有中（在跑）——来自宿主的 run 登记表（pg 是 `reins_runs`，单进程是 `runs.get(id)`）；
 * - 最后一条 RUN_MARKER_TYPES 事件——上一个 run 的结局，或者"起了步却没收尾"。
 *
 * 这里全是纯函数：分类口径只此一处，store-pg 的批量快照与宿主自己的登记表都调 `runStatusOf`。
 *
 * 已知误判窗口（不用代码兜，写进文档）：
 * - 续期抛错只告警不中止：存储持续不可用到租约过期而 run 还在跑，会误判 interrupted，下一次心跳恢复后自愈；
 * - 释放失败只告警：最多 ttl 内误判 running；
 * - 进程被杀：要等租约到期才显示 interrupted；
 * - run 中途 fork 出来的会话继承"未收尾"，判 interrupted；
 * - 起步时已中止的续跑 run 不写 tools_bound 却照写 approval_decision：进程恰好死在它与 run_paused 之间时，
 *   状态仍是上一个 paused(approval)（窗口只有一次 append）；
 * - 子代理冒泡暂停后，下一个父 run 起步即被非停止原因中止：新的 run_paused 里没有子代理那条（父日志查不到 childSessionId），
 *   判 paused(host) 而子会话其实还在等，与"不往父会话上浮子状态"同一边界。
 */
import type { Event } from "../events/base.js"
import type { AwaitingCall, CoreEvent } from "../events/core.js"
import { createCoreRegistry, type EventSchemaRegistry } from "../events/registry.js"
import { isPauseCode } from "./pause-code.js"
import { isClientTool } from "./tools.js"
import type { Interruption, PauseReason, Tool, ToolCallEvent } from "./types.js"

/**
 * 会话里"最后一个 run"的标记事件类型（真源索引）。store 查最后一条标记时按这张表过滤（store-pg 绑参数，不在 SQL 里另写一份）
 */
export const RUN_MARKER_TYPES = ["core.tools_bound", "core.run_paused", "core.run_ended"] as const

const MARKER_SET: ReadonlySet<string> = new Set(RUN_MARKER_TYPES)

/** 一段时间线里最后一条 RUN_MARKER_TYPES 事件。非 pg 宿主（内存 / SQLite、自己的登记表）用它取 lastMarker */
export function lastRunMarker(events: readonly Event[]): Event | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e !== undefined && MARKER_SET.has(e.type)) return e
  }
  return undefined
}

/**
 * 暂停时在等外部答复的调用（真源索引）。以时间线的 pending 为准，不从本次中断列表推：起步时已中止的 run、
 * 工具批中途中止后排在后面的调用，中断列表里都没有，但它们可能仍在等审批。
 *
 * 逐个 pending 调用判：有 approval_request 无 approval_decision → approval；否则工具是客户端工具 → client_tool；
 * 否则本次中断里有它的子代理冒泡 → subagent；都不是就不列（没执行、下次补跑）。
 * 找不到对应事件或工具时只跳过该条、不抛错：一个元数据字段不能把暂停变成崩溃，否则续跑凭据就丢了。
 */
export function awaitingOf(input: {
  timeline: readonly Event[]
  pending: readonly ToolCallEvent[]
  tools: readonly Tool[]
  interruptions: readonly Interruption[]
}): AwaitingCall[] {
  const requestedAt = new Map<string, number>()
  const decided = new Set<string>()
  for (const raw of input.timeline) {
    // 注册表不校验 payload：坏载荷的事件只跳过，不能让暂停变成崩溃
    const id = (raw.payload as { toolCallId?: unknown } | null | undefined)?.toolCallId
    if (typeof id !== "string") continue
    if (raw.type === "core.approval_request" && !requestedAt.has(id)) requestedAt.set(id, raw.at)
    if (raw.type === "core.approval_decision") decided.add(id)
  }
  const awaiting: AwaitingCall[] = []
  for (const call of input.pending) {
    const { toolCallId, name } = call.payload
    const at = requestedAt.get(toolCallId)
    if (at !== undefined && !decided.has(toolCallId)) {
      awaiting.push({ kind: "approval", toolCallId, name, requestedAt: at })
      continue
    }
    const tool = input.tools.find((t) => t.name === name)
    if (tool !== undefined && isClientTool(tool)) {
      awaiting.push({ kind: "client_tool", toolCallId, name })
      continue
    }
    const sub = input.interruptions.find((i) => i.kind === "subagent" && i.toolCallId === toolCallId)
    if (sub?.kind === "subagent") {
      awaiting.push({
        kind: "subagent",
        toolCallId,
        name,
        childSessionId: sub.childSessionId,
        reason: sub.reason,
      })
    }
  }
  return awaiting
}

/**
 * 一个会话此刻的运行状态。
 * - running：租约持有中（不看标记）；
 * - idle：没有任何 run 标记（新会话、交接目标会话还没起过 run）；
 * - unknown：最后一个 run 没承诺收尾（老版本、TanStack 适配器），或标记读不出 / 形状不合规（fail-closed，不猜）；
 * - interrupted：起了步（tools_bound 带 marksEnd）却没有收尾，且租约不在——进程被杀、生成器抛错；
 * - 其余四种是上一个 run 的结局。`seq` 区分前后两个 run，`endedAt` / `startedAt` 与事件 `at` 同一时钟（循环时钟）。
 */
export type RunStatus =
  | { state: "running" }
  | { state: "idle" }
  | { state: "unknown" }
  | { state: "interrupted"; seq: number; startedAt: number }
  | { state: "done"; seq: number; endedAt: number }
  | { state: "handoff"; seq: number; endedAt: number; toSessionId: string }
  | { state: "error"; seq: number; endedAt: number; category: string }
  | {
      state: "paused"
      seq: number
      endedAt: number
      reason: PauseReason
      stopped: boolean
      /** 老版本写的 run_paused 不带，为 undefined */
      awaiting: AwaitingCall[] | undefined
      /**
       * 暂停原因码（AdRate 建议 16）：Socket 暂停时给的，或内置来源的 `reins.*`。没给码的暂停（宿主中止、用户停止、
       * 审批 / 客户端工具 / 子代理）与老版本写的事件没有这个字段。给人看的 `note` 只在事件里，不进这里
       */
      code?: string
    }

const PAUSE_REASONS: ReadonlySet<string> = new Set<PauseReason>(["approval", "budget", "host"])

const isNonEmptyString = (x: unknown): x is string => typeof x === "string" && x !== ""

function isAwaitingCall(x: unknown): x is AwaitingCall {
  if (typeof x !== "object" || x === null) return false
  const a = x as Record<string, unknown>
  if (!isNonEmptyString(a.toolCallId) || typeof a.name !== "string") return false
  if (a.kind === "approval") return typeof a.requestedAt === "number" && Number.isFinite(a.requestedAt)
  if (a.kind === "client_tool") return true
  if (a.kind === "subagent")
    return isNonEmptyString(a.childSessionId) && typeof a.reason === "string" && PAUSE_REASONS.has(a.reason)
  return false
}

/**
 * 纯函数：租约 + 最后一条 run 标记 → 运行状态（真源索引）。
 * `lastMarker` 是存储读出的原始行即可：函数内过注册表 upcast，再自己做形状守卫——注册表只校验壳字段、不校验 payload。
 * 读不出（未来版本、未登记）或形状不合规一律 unknown，不抛错。
 */
export function runStatusOf(input: {
  held: boolean
  lastMarker: Event | undefined
  registry?: EventSchemaRegistry
}): RunStatus {
  // acquire 先于 tools_bound：持有租约这段时间里最后一条标记还是上一个 run 的，所以 held 优先
  if (input.held) return { state: "running" }
  if (input.lastMarker === undefined) return { state: "idle" }
  let marker: CoreEvent
  try {
    marker = (input.registry ?? createCoreRegistry()).read<CoreEvent>(input.lastMarker)
  } catch {
    return { state: "unknown" }
  }
  const p = (typeof marker.payload === "object" && marker.payload !== null ? marker.payload : {}) as Record<
    string,
    unknown
  >
  const { seq, at } = marker
  switch (marker.type) {
    case "core.tools_bound":
      return p.marksEnd === true ? { state: "interrupted", seq, startedAt: at } : { state: "unknown" }
    case "core.run_paused": {
      if (typeof p.reason !== "string" || !PAUSE_REASONS.has(p.reason)) return { state: "unknown" }
      if (p.stopped !== undefined && p.stopped !== true) return { state: "unknown" }
      if (p.awaiting !== undefined && !(Array.isArray(p.awaiting) && p.awaiting.every(isAwaitingCall)))
        return { state: "unknown" }
      // 原因码在场就必须合规（与写入同一个 isPauseCode）：绕过循环写进来的怪值不往下游传
      if (p.code !== undefined && !isPauseCode(p.code)) return { state: "unknown" }
      return {
        state: "paused",
        seq,
        endedAt: at,
        reason: p.reason as PauseReason,
        stopped: p.stopped === true,
        awaiting: p.awaiting as AwaitingCall[] | undefined,
        ...(p.code !== undefined ? { code: p.code } : {}),
      }
    }
    case "core.run_ended": {
      if (p.status === "done") return { state: "done", seq, endedAt: at }
      if (p.status === "handoff" && isNonEmptyString(p.toSessionId))
        return { state: "handoff", seq, endedAt: at, toSessionId: p.toSessionId }
      if (p.status === "error" && typeof p.category === "string")
        return { state: "error", seq, endedAt: at, category: p.category }
      return { state: "unknown" }
    }
    default:
      return { state: "unknown" }
  }
}
