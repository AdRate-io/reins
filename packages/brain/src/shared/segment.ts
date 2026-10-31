/**
 * "段"的判据（compact 与 pins 共用，2026-10-31 从 compact/request.ts 挪出）：段 = 会话开头或最近一次整理
 * （任何 decidedBy，含本轮投影新造的阈值兜底）之后、到下一次整理之前。全部从时间线读，没有跨轮状态：
 * 续跑、跨实例、多 run 的长期会话都一致。
 *
 * - compact 的整理请求：刚整理完、模型还没动过就不请（`modelActedSinceLastCompaction`）
 * - pins 的常驻快照：段起点取一份（`atSegmentStart`）
 */
import { type Event, isCompaction, type TurnContext } from "@reinsjs/core"

/** 模型的"动作"：正文或工具调用。thinking 不算——只想不做不改变段内状态 */
const isModelAction = (e: Event): boolean => e.type === "core.model_text" || e.type === "core.tool_call"

/**
 * 最后一次整理之后模型有没有动过（正文或工具调用）；从没整理过算动过。
 * 刚整理完、折后仍在软线以上时，先让模型干一轮活再请，免得整理一结束就被追着连请、撞上连续整理上限
 */
export function modelActedSinceLastCompaction(timeline: readonly Event[]): boolean {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]
    if (!e) continue
    if (isCompaction(e)) return false
    if (isModelAction(e)) return true
  }
  return true
}

/**
 * 是否处在段起点：本段（最近一次整理之后；从没整理过则从会话开头起）模型还没动过。
 * 与 `modelActedSinceLastCompaction` 的唯一差别是"从没整理过"：那边算动过（不该请整理），这里看会话开头以来有没有动过
 */
export function atSegmentStart(timeline: readonly Event[]): boolean {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]
    if (!e) continue
    if (isCompaction(e)) return true
    if (isModelAction(e)) return false
  }
  return true
}

/** 本段的事件：最近一次整理之后的（不含那条整理）；从没整理过则是整条时间线 */
export function currentSegment(timeline: readonly Event[]): readonly Event[] {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]
    if (e && isCompaction(e)) return timeline.slice(i + 1)
  }
  return timeline
}

/**
 * 截至此刻的时间线：本轮开始时的快照 + 本轮新增（投影新造的阈值 compaction、beforeModel 追加的说明）。
 * 后者只在 ctx.events 里、不在 ctx.timeline 里，按 seq 大于快照末尾取出
 */
export function timelineSoFar(ctx: TurnContext): Event[] {
  const end = ctx.timeline.at(-1)?.seq ?? 0
  const fresh = ctx.events.filter((e) => e.seq > end).sort((a, b) => a.seq - b.seq)
  return [...ctx.timeline, ...fresh]
}
