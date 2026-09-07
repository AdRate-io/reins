/**
 * 策略 2：折叠。用 compaction 事件的摘要替代它覆盖的 seq 区间；被折叠的原事件仍在日志里。
 *
 * 规则：
 * - 每条 compaction 隐藏 coversSeq 内、seq 小于自己的事件；多条 compaction 的隐藏范围取并集，
 *   被更晚的 compaction 盖住的旧 compaction 也隐藏（它的摘要已被新摘要吸收），但它的覆盖范围仍然生效。
 * - 幸存判定：一条被覆盖的事件，只有当**每一条**覆盖它的 compaction 都保留它时才幸存。
 *   保留 = 出现在该 compaction 的 pinsKept 里，或（默认开启）它本身是 kind=pin 的 system_note。
 *   模型 pin 过的东西默认穿越折叠，除非某次 compaction 明确不再保留它。
 * - 摘要放在被覆盖区间的位置（第一条 seq 大于区间上界的可见事件之前），而不是 compaction 自己的 seq 位置。
 *   模型多数时候折叠的是"直到现在"的前缀，两者重合；折叠旧的中间段时，摘要出现在原段的位置读起来才顺。
 *   所以投影输出的顺序可以与 seq 不一致 —— 投影是给模型看的视图，日志才按 seq。
 */
import type { Event } from "../events/base.js"
import type { CoreEventOf } from "../events/core.js"
import type { ProjectionStrategy } from "./types.js"

export type CompactionEvent = CoreEventOf<"core.compaction">

export function isCompaction(e: Event): e is CompactionEvent {
  return e.type === "core.compaction"
}

export function isPinNote(e: Event): boolean {
  return e.type === "core.system_note" && (e as CoreEventOf<"core.system_note">).payload.kind === "pin"
}

/** c 是否覆盖 e：seq 落在闭区间内且早于 c 自身 */
export function covers(c: CompactionEvent, e: Event): boolean {
  const [from, to] = c.payload.coversSeq
  return e.id !== c.id && e.seq >= from && e.seq <= to && e.seq < c.seq
}

/** 一次 compaction 是否保留某条被它覆盖的事件。折叠与裁剪共用这一条规则 */
export function keptBy(c: CompactionEvent, e: Event, autoKeepPinNotes: boolean): boolean {
  return c.payload.pinsKept.includes(e.id) || (autoKeepPinNotes && isPinNote(e))
}

export interface FoldOptions {
  /** kind=pin 的 system_note 不必出现在 pinsKept 也自动幸存；默认 true */
  autoKeepPinNotes?: boolean
}

export function foldCompactions(opts: FoldOptions = {}): ProjectionStrategy {
  const autoKeep = opts.autoKeepPinNotes ?? true
  return {
    name: "fold-compactions",
    apply(events) {
      const compactions = events.filter(isCompaction)
      if (compactions.length === 0) return { events: [...events] }

      // 1. 判定隐藏：被覆盖且并非所有覆盖者都保留它
      const hidden = new Set<string>()
      for (const e of events) {
        const covering = compactions.filter((c) => covers(c, e))
        if (covering.length > 0 && !covering.every((c) => keptBy(c, e, autoKeep))) hidden.add(e.id)
      }

      // 2. 可见的普通事件按原顺序排好；可见的 compaction 插到其区间位置
      const body = events.filter((e) => !hidden.has(e.id) && !isCompaction(e))
      const visibleCompactions = compactions.filter((c) => !hidden.has(c.id)).sort((a, b) => a.seq - b.seq)
      const insertBefore = new Map<number, CompactionEvent[]>()
      for (const c of visibleCompactions) {
        // 区间上界若越过自身 seq，按隐藏规则只到 seq-1 为止；放置位置与隐藏范围保持一致
        const to = Math.min(c.payload.coversSeq[1], c.seq - 1)
        let idx = body.findIndex((e) => e.seq > to)
        if (idx === -1) idx = body.length
        const bucket = insertBefore.get(idx)
        if (bucket) bucket.push(c)
        else insertBefore.set(idx, [c])
      }

      const out: Event[] = []
      for (let i = 0; i <= body.length; i++) {
        const bucket = insertBefore.get(i)
        if (bucket) out.push(...bucket)
        const e = body[i]
        if (e) out.push(e)
      }
      return { events: out }
    },
  }
}
