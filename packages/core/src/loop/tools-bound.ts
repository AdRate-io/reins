/**
 * 工具表快照与变化说明（P1，技术方案 §10"工具表变化告知模型"）。
 *
 * 循环每次起步 append 一条模型不可见的 `core.tools_bound`（本次 run 的工具名与 configHash）；
 * 与日志里上一条 tools_bound 比对，有增删就再 append 一条模型可见的 `system_note(kind=host)`。
 * 宪法一"让它看见"：MCP 服务器加减了工具、宿主按请求换了配置，模型该知道自己手里的东西变了，
 * 而不是从一次"未知工具"的失败里猜出来。首次 run 没有比对对象，不出说明。
 *
 * 这里全是纯函数，runLoop 与 TanStack 适配器共用；TanStack 那边有自己的循环，同一份文案与判定才不会两处漂移。
 */
import type { Event } from "../events/base.js"
import type { CoreEventOf } from "../events/core.js"
import type { CoreEventDraft } from "../events/create.js"

export type ToolsBoundEvent = CoreEventOf<"core.tools_bound">

/** 日志里最后一条 tools_bound（上一次 run 起步时的工具表），没有则 undefined */
export function lastToolsBound(timeline: readonly Event[]): ToolsBoundEvent | undefined {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]
    if (e?.type === "core.tools_bound") return e as ToolsBoundEvent
  }
  return undefined
}

export interface ToolNamesDiff {
  added: string[]
  removed: string[]
}

/** 两份工具名的增删（各自排序）；相同返回 undefined。名字集合比对，不看顺序 */
export function diffToolNames(
  previous: readonly string[],
  next: readonly string[],
): ToolNamesDiff | undefined {
  const before = new Set(previous)
  const after = new Set(next)
  const added = [...after].filter((n) => !before.has(n)).sort()
  const removed = [...before].filter((n) => !after.has(n)).sort()
  if (added.length === 0 && removed.length === 0) return undefined
  return { added, removed }
}

/**
 * 给模型看的变化说明（英文，进模型上下文）。只列名字：说明在工具表里，重复一遍既费 token 又可能与工具表不一致；
 * 被移除的工具明说"不能再调用"，模型才不会按记忆去调一个已经不存在的工具。
 */
export function renderToolChangeNote(diff: ToolNamesDiff): string {
  const lines = ["Your available tools changed since the previous run."]
  if (diff.added.length > 0) lines.push(`Added: ${diff.added.join(", ")}.`)
  if (diff.removed.length > 0)
    lines.push(`Removed (no longer callable, even if earlier turns used them): ${diff.removed.join(", ")}.`)
  return lines.join(" ")
}

/**
 * 起步要 append 的草稿：一条 tools_bound，工具表与上一条相比有增删且 `announce` 为真时再加一条 system_note。
 * 顺序固定：快照在前、说明在后 —— 说明是从快照比对得出的，日志里的因果也该这么排。
 */
export function toolsBoundDrafts(input: {
  timeline: readonly Event[]
  toolNames: readonly string[]
  configHash: string
  announce: boolean
}): CoreEventDraft[] {
  const toolNames = [...input.toolNames].sort()
  const drafts: CoreEventDraft[] = [
    { type: "core.tools_bound", actor: "system", payload: { toolNames, configHash: input.configHash } },
  ]
  const previous = lastToolsBound(input.timeline)
  if (!input.announce || previous === undefined) return drafts
  const diff = diffToolNames(previous.payload.toolNames, toolNames)
  if (!diff) return drafts
  drafts.push({
    type: "core.system_note",
    actor: "host",
    payload: { kind: "host", text: renderToolChangeNote(diff), meta: { toolsChanged: diff } },
  })
  return drafts
}
