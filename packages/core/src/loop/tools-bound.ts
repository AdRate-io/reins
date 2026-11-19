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
import type { ContentPart, Event } from "../events/base.js"
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

/** 一侧（增或删）超过这个数就不再逐个列名，只列这么多个并报总数 */
const TOOL_CHANGE_LIST_MAX = 20

/**
 * 给模型看的变化说明（英文，进模型上下文）。只列名字：说明在工具表里，重复一遍既费 token 又可能与工具表不一致；
 * 被移除的工具明说"不能再调用"，模型才不会按记忆去调一个已经不存在的工具。
 *
 * 一侧超过 `TOOL_CHANGE_LIST_MAX` 件（MCP 凭据过期 / 恢复会一次增删几百件，AdRate 建议 15）只列这么多个、报总数。
 * `tiers` 是优先档，前档先列、档内按字母序；不在任何档的按字母序补足，让模型看得出是哪一类工具变了。
 * `toolsBoundDrafts` 传 [调用过的, 只在文本里出现过的]（见 `toolMentionTiers`）：往期工具表不进历史，
 * 模型只可能凭记忆去调这些。说明写进日志后每次请求都回放，几百个名字会常驻上下文；
 * 完整增删照旧记在 `meta.toolsChanged` 与 tools_bound，压缩的只是这句话。
 */
export function renderToolChangeNote(
  diff: ToolNamesDiff,
  tiers: readonly ReadonlySet<string>[] = [],
): string {
  const lines = ["Your available tools changed since the previous run."]
  const { added, removed } = diff
  if (added.length > TOOL_CHANGE_LIST_MAX)
    lines.push(`Added ${added.length} tools, including ${sampleNames(added, tiers)}.`)
  else if (added.length > 0) lines.push(`Added: ${added.join(", ")}.`)
  if (removed.length > TOOL_CHANGE_LIST_MAX)
    lines.push(
      `Removed ${removed.length} tools (no longer callable, even if earlier turns used them), including ${sampleNames(removed, tiers)}.`,
    )
  else if (removed.length > 0)
    lines.push(`Removed (no longer callable, even if earlier turns used them): ${removed.join(", ")}.`)
  return lines.join(" ")
}

/** 超上限一侧的列名：按档取（names 已排序，过滤不改变顺序），不在任何档的殿后，截到上限，缀 "and N more" */
function sampleNames(names: readonly string[], tiers: readonly ReadonlySet<string>[]): string {
  const rank = (n: string) => {
    const i = tiers.findIndex((t) => t.has(n))
    return i < 0 ? tiers.length : i
  }
  const picked = names
    .map((n, i) => ({ n, i, r: rank(n) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, TOOL_CHANGE_LIST_MAX)
    .map((x) => x.n)
  return `${picked.join(", ")}, and ${names.length - picked.length} more`
}

/**
 * `candidates` 里在时间线上出现过的名字，分两档：
 * - 调用过：tool_call / tool_result 的工具名、tool_reference 引用过（lazy-tools 原生路径取回）；
 * - 只在模型可见文本里作为整词出现过：用户消息、模型正文与思考、工具结果文本、说明、整理摘要、调用入参里的字符串。
 *   覆盖 lazy-tools 过滤路径的 `tool_find` 取回（结果文本里带定义）而 core 不必认识 brain —— 依赖方向只指向 core。
 * 跳过以前的工具变化说明（带 `meta.toolsChanged`）：那里为凑满上限补进去的名字不是模型用过的，算进来会一轮轮自我强化，
 * 把真调用过的挤出前 20 个。用整个日志而不是当前视图：被整理折起的仍可 recall，宁可多列不漏列。
 * 已知限制：按 [A-Za-z0-9_-] 切词（厂商只收这个字符集的工具名，MCP 名字会改写进来），名字与别的词用连字符粘连时认不出。
 */
function toolMentionTiers(
  timeline: readonly Event[],
  candidates: Iterable<string>,
): [Set<string>, Set<string>] {
  const wanted = new Set(candidates)
  const called = new Set<string>()
  const mentioned = new Set<string>()
  const call = (name: string) => {
    if (wanted.has(name)) called.add(name)
  }
  const scan = (text: string) => {
    TOOL_WORD_RE.lastIndex = 0
    for (let m = TOOL_WORD_RE.exec(text); m !== null; m = TOOL_WORD_RE.exec(text))
      if (wanted.has(m[0])) mentioned.add(m[0])
  }
  /** 入参按值递归取字符串再切词，不扫 JSON 文本 —— 换行在 JSON 文本里是 `\n` 两个字符，切词时 n 会粘到后面的名字上 */
  const scanValue = (v: unknown): void => {
    if (typeof v === "string") scan(v)
    else if (Array.isArray(v)) for (const x of v) scanValue(x)
    else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) scanValue(x)
  }
  const scanParts = (parts: readonly ContentPart[]) => {
    for (const part of parts) {
      if (part.type === "text") scan(part.text)
      else if (part.type === "tool_reference") call(part.name)
    }
  }
  for (const e of timeline) {
    switch (e.type) {
      case "core.user_message":
        scanParts((e as CoreEventOf<"core.user_message">).payload.content)
        break
      case "core.model_text":
        scan((e as CoreEventOf<"core.model_text">).payload.text)
        break
      case "core.model_thinking":
        scan((e as CoreEventOf<"core.model_thinking">).payload.text)
        break
      case "core.compaction":
        scan((e as CoreEventOf<"core.compaction">).payload.summary)
        break
      case "core.system_note": {
        const p = (e as CoreEventOf<"core.system_note">).payload
        if (p.meta?.toolsChanged === undefined) scan(p.text)
        break
      }
      case "core.tool_call": {
        const p = (e as CoreEventOf<"core.tool_call">).payload
        call(p.name)
        // 字符串入参是线上原文（解析失败才这样存），能解析就按值扫
        if (typeof p.args === "string") {
          try {
            scanValue(JSON.parse(p.args))
          } catch {
            scan(p.args)
          }
        } else scanValue(p.args)
        break
      }
      case "core.tool_result": {
        const p = (e as CoreEventOf<"core.tool_result">).payload
        call(p.name)
        scanParts(p.content)
        break
      }
    }
  }
  for (const n of called) mentioned.delete(n)
  return [called, mentioned]
}

const TOOL_WORD_RE = /[A-Za-z0-9_-]+/g

/**
 * 起步要 append 的草稿：一条 tools_bound，工具表与上一条相比有增删且 `announce` 为真时再加一条 system_note。
 * 顺序固定：快照在前、说明在后 —— 说明是从快照比对得出的，日志里的因果也该这么排。
 */
export function toolsBoundDrafts(input: {
  timeline: readonly Event[]
  toolNames: readonly string[]
  configHash: string
  announce: boolean
  /** 写入方承诺本 run 以终结事件收尾（只有 runLoop 传 true，见 `ToolsBoundPayload.marksEnd`） */
  marksEnd?: boolean
}): CoreEventDraft[] {
  const toolNames = [...input.toolNames].sort()
  const drafts: CoreEventDraft[] = [
    {
      type: "core.tools_bound",
      actor: "system",
      payload: {
        toolNames,
        configHash: input.configHash,
        ...(input.marksEnd ? { marksEnd: true as const } : {}),
      },
    },
  ]
  const previous = lastToolsBound(input.timeline)
  if (!input.announce || previous === undefined) return drafts
  const diff = diffToolNames(previous.payload.toolNames, toolNames)
  if (!diff) return drafts
  // 只在要压缩时才扫时间线（长会话的日志可能很大）
  const tiers =
    diff.added.length > TOOL_CHANGE_LIST_MAX || diff.removed.length > TOOL_CHANGE_LIST_MAX
      ? toolMentionTiers(input.timeline, [...diff.added, ...diff.removed])
      : []
  drafts.push({
    type: "core.system_note",
    actor: "host",
    payload: { kind: "host", text: renderToolChangeNote(diff, tiers), meta: { toolsChanged: diff } },
  })
  return drafts
}
