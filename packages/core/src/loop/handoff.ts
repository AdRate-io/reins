/**
 * 交接新会话的开场草稿（runLoop 与 TanStack 适配器共用，两处开场形状不分叉）。
 *
 * 形状：seq 1 摘要说明 → 意图带来的开场事件（如 pin，原样）→ 触发消息（有才写）。
 *
 * 发起者如实记（宪法二：事件带真实发起者；全库审查 2026-11-25 #52）：
 * - 摘要是交接决定者写的：`intent.by`（缺省 model），不再一律记成宿主说明——模型写的摘要不该拿 system 信任；
 * - 触发消息只有逐字（去首尾空白）取自旧会话一条 `actor: "user"` 的用户消息时才记为用户的话，trust 随原事件，
 *   provenance 指回原事件；否则是交接决定者自拟的（模型被工具结果里的注入诱导写的也在此列），记在它名下；
 * - 摘要与自拟触发消息的 provenance 指回旧会话的 `core.handoff` 事件，审计分得清这句话从哪来。
 *
 * 模型看到的字节不变：降级层按事件类型落角色、只看 `trust === "untrusted"` 包标记，不读 actor。
 */
import type { Event, Provenance } from "../events/base.js"
import type { CoreEventOf } from "../events/core.js"
import type { EventDraft } from "../events/create.js"
import type { HandoffIntent } from "./types.js"

/** 交接开场事件 provenance 的来源名（与 brain handoff 模块带过去的 pin 同名） */
export const HANDOFF_PROVENANCE_SOURCE = "handoff"

/** 用户消息的文字（文本片段拼接、去首尾空白），与 brain `lastVisibleUserMessage` 同一取法 */
function userTextOf(e: CoreEventOf<"core.user_message">): string {
  return e.payload.content
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim()
}

/**
 * @param handoffEvent 旧会话刚写下的 `core.handoff`（摘要与自拟触发消息的出处）
 * @param timeline 旧会话完整时间线（找触发消息逐字出自哪条真实用户消息；取最近的一条）
 */
export function handoffOpeningDrafts(
  intent: HandoffIntent,
  handoffEvent: Event,
  timeline: readonly Event[],
): EventDraft[] {
  const by = intent.by ?? "model"
  const fromHandoff: Provenance = { source: HANDOFF_PROVENANCE_SOURCE, ref: handoffEvent.id }
  const opening: EventDraft[] = [
    {
      type: "core.system_note",
      actor: by,
      payload: { kind: "host", text: intent.summary },
      provenance: fromHandoff,
    },
    ...(intent.opening ?? []),
  ]
  if (intent.triggerMessage === undefined) return opening
  const wanted = intent.triggerMessage.trim()
  let source: CoreEventOf<"core.user_message"> | undefined
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i] as Event
    if (e.type !== "core.user_message" || e.actor !== "user") continue
    const u = e as CoreEventOf<"core.user_message">
    if (userTextOf(u) === wanted) {
      source = u
      break
    }
  }
  const content = [{ type: "text" as const, text: intent.triggerMessage }]
  opening.push(
    source
      ? {
          type: "core.user_message",
          actor: "user",
          trust: source.trust,
          payload: { content },
          provenance: { source: HANDOFF_PROVENANCE_SOURCE, ref: source.id },
        }
      : { type: "core.user_message", actor: by, payload: { content }, provenance: fromHandoff },
  )
  return opening
}
