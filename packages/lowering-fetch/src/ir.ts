/**
 * 事件 → 中间表示（IR）：三条线协议共用的一趟遍历。
 *
 * 这一步只做与协议无关的事：
 * 1. **分组**——连续的 model 事件（thinking / text / tool_call）合成一条 assistant 轮，遇到非 model 事件或来源变了就收口；
 * 2. **后移**——"同批 tool_result 必须紧跟 tool_use"是厂商硬规则，而时间线里说明、摘要、用户插话都可能落在两者之间；
 *    结果没到齐时它们先攒着，到齐后按原顺序放出（`deferred: true`）。日志顺序不动（宪法二），只在翻译产物里挪位；
 * 3. **trust 标注**——untrusted 内容包 `<untrusted source=…>`（core 的同一份纯函数），转义过的记 `escaped`。
 *
 * 每种事件落到线协议的哪个位置、算 exact 还是 lossy，由各协议的 encoder 决定并记 LandingRecord；IR 只提供判定所需的事实。
 * 输出顺序就是线上顺序；`orderLandings` 把 encoder 记下的落点按输入事件顺序排回去（LoweredRequest.landings 的契约）。
 */
import {
  type ContentPart,
  type CoreEvent,
  type Event,
  type LandingRecord,
  markUntrusted,
  markUntrustedText,
  needsUntrustedMark,
  type SystemNotePayload,
  untrustedSourceOf,
} from "@reinsjs/core"

/** 模型事件 replay 里记录的来源，产出与回放两头共用（与 lowering-pi 同字段，两条路线的事件可互换） */
export interface ModelOrigin {
  provider: string
  api: string
  model: string
}

export type IrBlock =
  | { type: "thinking"; event: Event; text: string; replay: Record<string, unknown> }
  | { type: "text"; event: Event; text: string; replay: Record<string, unknown> }
  | {
      type: "tool_call"
      event: Event
      id: string
      name: string
      args: unknown
      replay: Record<string, unknown>
    }

export type IrItem =
  | { kind: "user"; event: Event; parts: ContentPart[]; escaped: boolean; deferred: boolean }
  | { kind: "assistant"; origin: ModelOrigin; blocks: IrBlock[]; at: number }
  | {
      kind: "tool_result"
      event: Event
      toolCallId: string
      name: string
      parts: ContentPart[]
      isError: boolean
      escaped: boolean
    }
  | {
      kind: "system_note"
      event: Event
      noteKind: SystemNotePayload["kind"]
      text: string
      escaped: boolean
      deferred: boolean
    }
  | { kind: "compaction"; event: Event; text: string; escaped: boolean; deferred: boolean }
  /** 运维事件与 ext.*：不下发，encoder 只记落点 */
  | { kind: "dropped"; event: Event; note: string }

export interface IrInput {
  events: readonly Event[]
  /** 当前请求的目标模型：replay 没写来源的模型事件按它算 */
  target: ModelOrigin
  /** trust=untrusted 的内容包 <untrusted source=…>（§14）。缺省 true；关掉是宿主自担风险 */
  trustMarkers?: boolean
}

export const DEFERRED_NOTE = "已后移到同批工具结果之后（工具结果必须紧跟调用）"
export const ESCAPED_NOTE = "不可信内容里含提前闭合的 </untrusted，已转义"
export const NOT_SENT_NOTE = "运维事件不下发（投影默认已过滤）"

function originOf(replay: Record<string, unknown> | undefined, fallback: ModelOrigin): ModelOrigin {
  const r = (replay ?? {}) as Partial<ModelOrigin>
  return {
    provider: typeof r.provider === "string" ? r.provider : fallback.provider,
    api: typeof r.api === "string" ? r.api : fallback.api,
    model: typeof r.model === "string" ? r.model : fallback.model,
  }
}

export function sameOrigin(a: ModelOrigin, b: ModelOrigin): boolean {
  return a.provider === b.provider && a.api === b.api && a.model === b.model
}

/**
 * 是否来自别家：只比 provider 与 api。响应里报告的模型 id 常与请求的不同（日期后缀、别名、网关改名），
 * 同家同协议下回放数据仍可用，不算有损。
 */
export function foreignOrigin(a: ModelOrigin, target: ModelOrigin): boolean {
  return a.provider !== target.provider || a.api !== target.api
}

export function eventsToIr(input: IrInput): IrItem[] {
  const { target } = input
  const trustMarkers = input.trustMarkers !== false
  const items: IrItem[] = []
  let group: { origin: ModelOrigin; blocks: IrBlock[]; at: number } | null = null
  /** 已下发 tool_call、结果还没到的调用 id；非空即"这批结果没到齐" */
  const awaiting = new Set<string>()
  const deferred: IrItem[] = []

  const content = (e: Event, parts: readonly ContentPart[]): { parts: ContentPart[]; escaped: boolean } => {
    if (!trustMarkers || !needsUntrustedMark(e)) return { parts: [...parts], escaped: false }
    return markUntrusted(parts, untrustedSourceOf(e))
  }
  const text = (e: Event, s: string): { text: string; escaped: boolean } => {
    if (!trustMarkers || !needsUntrustedMark(e)) return { text: s, escaped: false }
    return markUntrustedText(s, untrustedSourceOf(e))
  }
  const release = () => {
    for (const d of deferred) items.push(d)
    deferred.length = 0
  }
  /** 说明 / 摘要 / 用户消息：结果没到齐就先攒着，item 上标 deferred */
  const place = (item: Extract<IrItem, { deferred: boolean }>) => {
    if (awaiting.size > 0) {
      deferred.push({ ...item, deferred: true })
      return
    }
    items.push(item)
  }
  const flush = () => {
    if (!group) return
    items.push({ kind: "assistant", origin: group.origin, blocks: group.blocks, at: group.at })
    for (const b of group.blocks) if (b.type === "tool_call") awaiting.add(b.id)
    group = null
  }
  /** 新的模型输出到来：这批调用的结果不会再来了（视图被切在结果之前），后移的一切放出 */
  const settle = () => {
    awaiting.clear()
    release()
  }
  const assistant = (e: Event, origin: ModelOrigin) => {
    if (group && !sameOrigin(group.origin, origin)) flush()
    if (!group) {
      settle()
      group = { origin, blocks: [], at: e.at }
    }
    return group
  }

  for (const raw of input.events) {
    const e = raw as CoreEvent
    switch (e.type) {
      case "core.user_message": {
        flush()
        const c = content(e, e.payload.content)
        place({ kind: "user", event: e, parts: c.parts, escaped: c.escaped, deferred: false })
        break
      }
      case "core.model_thinking": {
        assistant(e, originOf(e.replay, target)).blocks.push({
          type: "thinking",
          event: e,
          text: e.payload.text,
          replay: e.replay ?? {},
        })
        break
      }
      case "core.model_text": {
        assistant(e, originOf(e.replay, target)).blocks.push({
          type: "text",
          event: e,
          text: e.payload.text,
          replay: e.replay ?? {},
        })
        break
      }
      case "core.tool_call": {
        assistant(e, originOf(e.replay, target)).blocks.push({
          type: "tool_call",
          event: e,
          id: e.payload.toolCallId,
          name: e.payload.name,
          args: e.payload.args,
          replay: e.replay ?? {},
        })
        break
      }
      case "core.tool_result": {
        flush()
        const c = content(e, e.payload.content)
        items.push({
          kind: "tool_result",
          event: e,
          toolCallId: e.payload.toolCallId,
          name: e.payload.name,
          parts: c.parts,
          isError: e.payload.isError,
          escaped: c.escaped,
        })
        awaiting.delete(e.payload.toolCallId)
        if (awaiting.size === 0) release()
        break
      }
      case "core.system_note": {
        flush()
        const t = text(e, e.payload.text)
        place({
          kind: "system_note",
          event: e,
          noteKind: e.payload.kind,
          text: t.text,
          escaped: t.escaped,
          deferred: false,
        })
        break
      }
      case "core.compaction": {
        flush()
        const t = text(e, e.payload.summary)
        place({ kind: "compaction", event: e, text: t.text, escaped: t.escaped, deferred: false })
        break
      }
      case "core.approval_request":
      case "core.approval_decision":
      case "core.run_paused":
      case "core.run_resumed":
      case "core.budget_usage":
      case "core.memory_op":
      case "core.handoff":
      case "core.tools_bound":
      case "core.error":
        // 不下发的事件也不打断 assistant 分组：模型看不见它，它就不该切开模型的一轮输出
        items.push({ kind: "dropped", event: e, note: NOT_SENT_NOTE })
        break
      default:
        items.push({ kind: "dropped", event: raw, note: `无通用落点：${raw.type}` })
    }
  }
  flush()
  settle()
  return items
}

/** 把 encoder 记下的落点按输入事件顺序排回去：LoweredRequest.landings 承诺"每条输入事件一条记录，顺序与输入一致" */
export function orderLandings(events: readonly Event[], landings: readonly LandingRecord[]): LandingRecord[] {
  const index = new Map<string, number>()
  for (const [i, e] of events.entries()) index.set(e.id, i)
  return [...landings].sort((a, b) => (index.get(a.eventId) ?? 0) - (index.get(b.eventId) ?? 0))
}
