/**
 * 从"模型本轮看到的视图 + 模型给的入参"算出一条 compaction 事件的内容。纯函数，无副作用，可单测、可回放。
 *
 * 切点规则与投影裁剪（core/projection/truncate.ts）同一口径，否则降级层会产出厂商拒收的请求：
 * 1. 只在模型轮的边界切：`keepRecentTurns = n` 表示保留视图里最后 n 个模型轮（含各自之后的工具结果、用户消息、说明），
 *    n = 0 即折叠本轮之前可见的一切。当前正在执行的这一轮不在视图里，天然完整保留 ——
 *    Anthropic 要求带 tool_use 的 assistant 轮连同 thinking 一起原样回放，拆开就是 400。
 * 2. seq 封闭：被覆盖的 seq 区间不能碰到保留部分。视图里唯一可能破坏它的是旧 compaction（它的 seq 大于自己覆盖的范围，
 *    位置却排在前面）。这种旧摘要不并入本次范围，留在视图里继续可见；只有保留部分为空（全部折叠）时才把它们一起吸收。
 * 3. 被覆盖事件里的 pin 说明与旧 compaction 已保留的事件继续幸存，记进 pinsKept —— 与 fold / truncate 的幸存定义一致；
 *    被后来说明 `supersedes` 取代的不幸存（B3：模型替换过的 pin、宿主抽取式 pin 的旧值）。
 * 4. 被折叠范围内**最近的一条用户消息**缺省也幸存。真模型实测（spikes/b2-compact-live）：用户说"先整理，然后做 X"，
 *    模型先整理、把这条消息也折了进去，摘要里只写"接着做第二部分"，整理完反问"第二部分要做什么"。模型没法复述
 *    它还没开始处理的指令，所以这条由库保住；长任务里它就是原始任务陈述，留着只多一条消息。
 * 5. （E3c）被折叠的工具结果列成清单附在摘要之后（`seq N tool(arguments) — 大小`），模型之后可用 recall 按 seq 取回。
 *    摘要是模型的取舍，清单是"事实上还在的东西"；两个模型族的实测都把复核过的字段值整理成了一句结论，
 *    清单让它至少知道去哪拿。脑子自己的工具（compact / pin / recall / fetch_blob 的回执）不列，只是噪音。
 */
import {
  type CompactionPayload,
  type Event,
  type FoldedToolResult,
  foldedToolResults,
  isCompaction,
  isPinNote,
  renderFoldedToolResults,
  splitTurns,
  supersededIds,
} from "@reinsjs/core"
import { PIN_TOOL_NAME } from "../pins/rules.js"
import { FETCH_BLOB_TOOL_NAME } from "../spill/rules.js"
import { COMPACT_TOOL_NAME, RECALL_TOOL_NAME } from "./rules.js"

export interface CompactArgs {
  summary: string
  keep: string[]
  keepRecentTurns: number
}

/** 模型入参 → 规范形态；不合法抛 RangeError（循环会把它作为 isError 的结果告知模型） */
export function parseCompactArgs(raw: unknown): CompactArgs {
  if (typeof raw !== "object" || raw === null) throw new RangeError("compact expects an object")
  const o = raw as Record<string, unknown>
  if (typeof o.summary !== "string" || o.summary.trim().length === 0) {
    throw new RangeError("`summary` must be a non-empty string")
  }
  const keep = o.keep ?? []
  if (!Array.isArray(keep) || !keep.every((k) => typeof k === "string")) {
    throw new RangeError("`keep` must be an array of strings")
  }
  const keepRecentTurns = o.keepRecentTurns ?? 0
  if (typeof keepRecentTurns !== "number" || !Number.isInteger(keepRecentTurns) || keepRecentTurns < 0) {
    throw new RangeError("`keepRecentTurns` must be a non-negative integer")
  }
  return { summary: o.summary.trim(), keep: keep.map((k) => k.trim()).filter(Boolean), keepRecentTurns }
}

/** 缺省不列进清单的工具：脑子自己的回执与切片，取回没有意义 */
export const MANIFEST_DEFAULT_EXCLUDE: ReadonlySet<string> = new Set([
  COMPACT_TOOL_NAME,
  RECALL_TOOL_NAME,
  PIN_TOOL_NAME,
  FETCH_BLOB_TOOL_NAME,
])

export const MANIFEST_HEADING = `Folded tool results (bring one back verbatim with ${RECALL_TOOL_NAME}({ seq })):`

export interface ManifestOptions {
  /** 最多列几条，其余折成一行。缺省 80 */
  maxItems?: number
  /** 不列的工具名；缺省 MANIFEST_DEFAULT_EXCLUDE */
  exclude?: ReadonlySet<string>
}

/**
 * 摘要正文 + 要点清单 + 被折叠工具结果清单，合成 compaction.summary。
 * 要点单列是为了模型（和 eval）一眼看到"什么被明确保留了"；结果清单让它知道"什么还能拿回来"。
 */
export function renderCompactionSummary(
  args: Pick<CompactArgs, "summary" | "keep">,
  folded: readonly FoldedToolResult[] = [],
  manifest: ManifestOptions = {},
): string {
  const parts = [args.summary]
  if (args.keep.length > 0)
    parts.push(`Key facts carried forward:\n${args.keep.map((k) => `- ${k}`).join("\n")}`)
  const list = renderFoldedToolResults(folded, { heading: MANIFEST_HEADING, ...manifest })
  if (list) parts.push(list)
  return parts.join("\n\n")
}

export type CompactPlan =
  | {
      ok: true
      payload: CompactionPayload
      /** 被折叠的原事件（不含旧 compaction） */
      folded: Event[]
      /** 一并吸收的旧摘要 */
      absorbed: Event[]
      /** 保留在视图里的最近模型轮数（可能比请求的多） */
      keptTurns: number
      /** 列进摘要的被折叠工具结果（E3c） */
      manifest: FoldedToolResult[]
    }
  | { ok: false; reason: string }

const ASSISTANT_TYPES: ReadonlySet<string> = new Set([
  "core.model_thinking",
  "core.model_text",
  "core.tool_call",
])

function minSeq(events: readonly Event[]): number {
  let m = Number.POSITIVE_INFINITY
  for (const e of events) if (e.seq < m) m = e.seq
  return m
}
function maxSeq(events: readonly Event[]): number {
  let m = 0
  for (const e of events) if (e.seq > m) m = e.seq
  return m
}

export interface PlanOptions {
  /**
   * 发起本次整理的 tool_call 事件 id。正常路径下它还不在视图里（本轮的模型输出在视图快照之后）；
   * 续跑补齐 pending 调用时它**在**视图里 —— 那一轮必须整个保留，否则 tool_call 被折掉、稍后 append 的
   * tool_result 成了孤儿，厂商拒收。
   */
  protectCallId?: string
  /** 被折叠范围内最近的一条用户消息原样幸存（进 pinsKept）。缺省 true，见文件头第 4 条 */
  keepLatestUserMessage?: boolean
  /** 完整时间线：取代关系（system_note.supersedes）在这里找，取代者可能已不在视图里。缺省只看视图 */
  timeline?: readonly Event[]
  /** 被折叠工具结果清单：false 不列；对象调条数与排除名单。缺省列、上限 80 条 */
  manifest?: false | ManifestOptions
}

export function planCompaction(
  visible: readonly Event[],
  args: CompactArgs,
  opts: PlanOptions = {},
): CompactPlan {
  // 切点：保留最后 n 个模型轮。splitTurns 与投影裁剪同一口径（连续的 thinking / text / tool_call 为一轮）
  const turns = splitTurns(visible)
  const modelTurnStarts: number[] = []
  let protectedStart = visible.length
  let offset = 0
  for (const t of turns) {
    if (t[0] && ASSISTANT_TYPES.has(t[0].type)) {
      modelTurnStarts.push(offset)
      if (opts.protectCallId !== undefined && t.some((e) => e.id === opts.protectCallId))
        protectedStart = offset
    }
    offset += t.length
  }
  let cut: number
  if (args.keepRecentTurns === 0) cut = visible.length
  else if (modelTurnStarts.length < args.keepRecentTurns) {
    return {
      ok: false,
      reason: `Nothing to fold: only ${modelTurnStarts.length} model turn(s) are visible before this one, and you asked to keep ${args.keepRecentTurns}.`,
    }
  } else cut = modelTurnStarts[modelTurnStarts.length - args.keepRecentTurns] as number
  cut = Math.min(cut, protectedStart)

  const before = visible.slice(0, cut)
  const kept = visible.slice(cut)
  const keptMin = minSeq(kept)

  // seq 封闭：旧 compaction 的 seq 若不小于保留部分的最小 seq，就不能进本次范围，留在视图里
  const absorbed = before.filter((e) => isCompaction(e) && e.seq < keptMin)
  const folded = before.filter((e) => !isCompaction(e))
  if (folded.length === 0) {
    return {
      ok: false,
      reason: "Nothing to fold: the visible history before the kept turns is already a summary.",
    }
  }

  const priorKept = new Set(absorbed.flatMap((c) => (isCompaction(c) ? c.payload.pinsKept : [])))
  let latestUser: Event | undefined
  if (opts.keepLatestUserMessage !== false) {
    for (let i = folded.length - 1; i >= 0 && !latestUser; i--) {
      if (folded[i]?.type === "core.user_message") latestUser = folded[i]
    }
  }
  const superseded = supersededIds(opts.timeline ?? visible)
  const survivors = folded.filter(
    (e) => !superseded.has(e.id) && (isPinNote(e) || priorKept.has(e.id) || e === latestUser),
  )
  // 清单的范围 = 本次折叠的可见事件 + 被吸收旧摘要盖住的原件（它们已不在视图里，只能从完整时间线找）。
  // 不这么做，第二次整理一吸收第一次，第一次列出的结果就从清单上消失了 —— 原件明明还在日志里。
  const survivorIds = new Set(survivors.map((e) => e.id))
  const manifestOpts =
    opts.manifest === false ? undefined : { exclude: MANIFEST_DEFAULT_EXCLUDE, ...opts.manifest }
  let manifest: FoldedToolResult[] = []
  if (manifestOpts) {
    const listed = new Set(folded.map((e) => e.id))
    const scope = folded.filter((e) => !survivorIds.has(e.id))
    if (opts.timeline) {
      for (const c of absorbed) {
        if (!isCompaction(c)) continue
        const [from, to] = c.payload.coversSeq
        for (const e of opts.timeline) {
          if (e.seq >= from && e.seq <= to && e.seq < c.seq && !listed.has(e.id) && !isCompaction(e)) {
            listed.add(e.id)
            scope.push(e)
          }
        }
      }
    }
    manifest = foldedToolResults(scope, {
      lookup: opts.timeline ?? visible,
      exclude: manifestOpts.exclude ?? MANIFEST_DEFAULT_EXCLUDE,
    })
  }
  const from = Math.min(
    minSeq(folded),
    ...absorbed.map((c) => (isCompaction(c) ? c.payload.coversSeq[0] : Number.POSITIVE_INFINITY)),
  )
  const to = Math.max(maxSeq(folded), maxSeq(absorbed))

  return {
    ok: true,
    payload: {
      coversSeq: [from, to],
      summary: renderCompactionSummary(args, manifest, manifestOpts ?? {}),
      decidedBy: "model",
      pinsKept: survivors.map((e) => e.id),
    },
    folded,
    absorbed,
    keptTurns: args.keepRecentTurns,
    manifest,
  }
}

/**
 * 一条事件是不是"某轮开始时、模型开口之前"追加的：阈值兜底的 compaction（投影新造）与系统注入的说明（感知等）。
 * 它们在日志里紧贴着该轮的模型输出之前，按轮归属时应算进**这一轮**，而不是上一轮的尾巴。
 */
function isPreModelEvent(e: Event): boolean {
  if (isCompaction(e)) return e.payload.decidedBy === "threshold"
  return e.type === "core.system_note" && e.actor === "system"
}

/**
 * 按轮切分完整时间线：一轮 = 开轮时追加的兜底 compaction / 说明 + 模型输出 + 之后到下一轮之前的一切（工具结果、
 * 模型自决的 compaction、用量、用户插话）。第一轮模型输出之前的开场事件（用户消息等）单独成一段。
 * 与投影的 splitTurns 不同：那是给视图切轮边界用的，这里要的是"每一轮期间发生了什么"。
 */
export function segmentTimelineByTurn(timeline: readonly Event[]): Event[][] {
  const starts: number[] = []
  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i] as Event
    const prev = timeline[i - 1]
    if (!ASSISTANT_TYPES.has(e.type) || (prev && ASSISTANT_TYPES.has(prev.type))) continue
    let j = i
    while (j > 0 && isPreModelEvent(timeline[j - 1] as Event) && !starts.includes(j - 1)) j--
    if (starts.at(-1) !== j) starts.push(j)
  }
  if (starts.length === 0) return timeline.length > 0 ? [[...timeline]] : []
  const segments: Event[][] = []
  if ((starts[0] as number) > 0) segments.push(timeline.slice(0, starts[0]))
  for (let k = 0; k < starts.length; k++) {
    segments.push(timeline.slice(starts[k], starts[k + 1] ?? timeline.length))
  }
  return segments
}

/**
 * 连续整理计数：从最近一轮往前，连续每轮都含 compaction（模型自决或阈值兜底）的这些轮里 compaction 的总数；
 * 遇到第一轮没有 compaction 的就停。传入的是本轮开始时的时间线快照，所以数的是"之前的轮"，本轮的另算。
 */
export function trailingCompactionRun(timeline: readonly Event[]): number {
  const segments = segmentTimelineByTurn(timeline)
  let count = 0
  for (let i = segments.length - 1; i >= 0; i--) {
    const n = (segments[i] as Event[]).filter(isCompaction).length
    if (n === 0) break
    count += n
  }
  return count
}
