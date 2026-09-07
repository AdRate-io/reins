/**
 * 策略 3：钉住重注入。
 *
 * 折叠策略让幸存的 pin 留在原地（区间内、摘要之前）。这里把它们挪到覆盖它的最新可见 compaction 之后，
 * 模型读到的顺序就是"摘要 → 仍然生效的约束/目标/关键事实 → 后续对话"。
 * 去掉本策略投影仍然正确，只是 pin 出现在摘要前面。
 */
import type { Event } from "../events/base.js"
import { covers, isCompaction } from "./fold.js"
import type { ProjectionStrategy } from "./types.js"

export function reinjectPins(): ProjectionStrategy {
  return {
    name: "reinject-pins",
    apply(events) {
      const compactions = events.filter(isCompaction)
      if (compactions.length === 0) return { events: [...events] }

      const moved = new Set<string>()
      const after = new Map<string, Event[]>()
      for (const e of events) {
        if (isCompaction(e)) continue
        const covering = compactions.filter((c) => covers(c, e))
        if (covering.length === 0) continue
        const target = covering.reduce((a, b) => (b.seq > a.seq ? b : a))
        moved.add(e.id)
        const bucket = after.get(target.id)
        if (bucket) bucket.push(e)
        else after.set(target.id, [e])
      }
      if (moved.size === 0) return { events: [...events] }

      const out: Event[] = []
      for (const e of events) {
        if (moved.has(e.id)) continue
        out.push(e)
        if (isCompaction(e)) {
          const bucket = after.get(e.id)
          if (bucket) out.push(...bucket)
        }
      }
      return { events: out }
    },
  }
}
