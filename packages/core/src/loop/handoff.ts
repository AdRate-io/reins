/**
 * 交接新会话的开场草稿（runLoop 与 TanStack 适配器共用，两处开场形状不分叉）。
 *
 * 形状：seq 1 摘要说明 → 意图带来的开场事件（如 pin，原样）→ 触发消息（有才写）。
 *
 * 发起者如实记（宪法二：事件带真实发起者；全库审查 2026-11-25 #52）：
 * - 摘要是交接决定者写的：`intent.by`（缺省 model），不再一律记成宿主说明——模型写的摘要不该拿 system 信任；
 * - 触发消息逐字（去首尾空白）取自旧会话一条用户消息时，按原事件的发起者与 trust 记（用户的仍是用户、宿主写的仍是宿主、
 *   上一次交接里模型自拟的仍是模型），provenance 指回原事件；否则是交接决定者自拟的（模型被工具结果里的注入诱导写的
 *   也在此列），记在它名下；
 * - 摘要与自拟触发消息的 provenance 指回旧会话的 `core.handoff` 事件，审计分得清这句话从哪来。
 *
 * 摘要说明的 `payload.kind` 刻意仍是 `"host"`、不随 actor 改：kind 是说明的类别（"perception" / "pin" / "budget"
 * 之外的通用说明一律 host，工具表变化说明也是 actor system + kind host），不表示谁写的——谁写的只看 actor。
 * 另加 "handoff" 类别要扩 SystemNotePayload 闭集、升 schemaVersion 写 upcast，而降级层与脑子模块按 kind 的分支
 * 对它都该与 host 同样处理，换来的只是重复 actor + provenance 已经给出的信息。
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
 * @param timeline 旧会话完整时间线（找触发消息逐字出自哪条用户消息；取最近的一条）
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
    if (e.type !== "core.user_message") continue
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
          actor: source.actor,
          trust: source.trust,
          payload: { content },
          provenance: { source: HANDOFF_PROVENANCE_SOURCE, ref: source.id },
        }
      : { type: "core.user_message", actor: by, payload: { content }, provenance: fromHandoff },
  )
  return opening
}
