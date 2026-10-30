/**
 * 到线请模型整理（OPT-261030-3）：用量过软线、本段还没请过时，在末尾追加一条说明请模型先 compact 再继续。
 *
 * 三层分工（宪法一）：模型自决整理是默认路径；它没动、用量过软线 → 这里请它整理（时机框架定、摘要模型写，
 * 记 decidedBy=forced）；还不动、过触发线 → core 投影链机械裁剪。
 *
 * 为什么是"末尾追加说明"而不是 tool_choice 强制或收窄工具表（spikes/forced-compact/，两族实测）：
 * 追加只动末尾，缓存照命中（DeepSeek 98% / Haiku 5.5 99.3%），模型照做（6/6、3/3）；DeepSeek thinking 模式拒绝
 * 一切强制 tool_choice，Haiku 5.5 接受但缓存归零；换工具表两家缓存都崩。
 *
 * 全部判据从时间线读，没有跨轮状态：续跑、多 run 的长期会话都成立。
 */
import {
  type CoreEventOf,
  contextOverheadOf,
  type Event,
  isCompaction,
  type TurnContext,
} from "@reinsjs/core"
import { COMPACT_TOOL_NAME } from "./rules.js"

/** 请求整理的缺省软线（占 contextLimit 的比例），低于阈值兜底的缺省触发线 85% */
export const DEFAULT_FORCE_AT = 0.75

export interface CompactRequestInfo {
  /** 本轮真实上下文占窗口的比例，如 "78%" */
  usage: string
  /** 阈值兜底的触发点，如 "85%"（与感知报的 autoFoldAt 同一口径） */
  autoFoldAt: string
}

export interface ForceOptions {
  /** 软线：真实上下文 ≥ contextLimit × at 时请模型整理。取 (0, 1)，缺省 0.75；不低于触发线时这一层永远不出现 */
  at?: number
  /** 自定义措辞 / 语言；必须是纯函数 */
  render?: (info: CompactRequestInfo) => string
}

/** 缺省说明：明确命令，不是建议（onset-pause 证明"建议在收尾前整理"无效，forced-compact 证明命令有效） */
export function renderCompactRequest(info: CompactRequestInfo): string {
  return (
    `Context window is ${info.usage} full; the harness folds the oldest turns mechanically at ${info.autoFoldAt}. ` +
    `Before doing anything else, call \`${COMPACT_TOOL_NAME}\` now to fold the conversation so far into your own summary ` +
    "(use keepRecentTurns to keep the turns you are actively working from), then continue the task."
  )
}

type Note = CoreEventOf<"core.system_note">

/** 某条事件是不是本模块追加的整理请求 */
export function isCompactRequest(e: Event): boolean {
  const n = e as Note
  return n.type === "core.system_note" && n.payload.meta?.compactRequest !== undefined
}

/** 时间线里最后一次整理（任何 decidedBy）之后有没有整理请求 —— "本段已经请过" */
export function compactRequestedSinceLastCompaction(timeline: readonly Event[]): boolean {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]
    if (!e || isCompaction(e)) return false
    if (isCompactRequest(e)) return true
  }
  return false
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

/** 本轮真实上下文占窗口的比例：投影估算 + 校准出的固定开销，与感知读数、阈值兜底同一把尺 */
export function contextUsageRatio(ctx: TurnContext): number {
  return (ctx.budget.used + contextOverheadOf(ctx.timeline)) / ctx.budget.contextLimit
}
