/**
 * 暂停原因码（2026-11-23，AdRate 建议 16）。
 *
 * `reason` 是三选一的闭集（approval / budget / host），事后只凭它分不清"是谁、为什么停的"：积分用完、预算触顶、
 * 连续整理失败落库后都是 budget。Socket 暂停时可以再带一个原因码 `code`，随 `note` 一起写进 `core.run_paused`，
 * `runStatusOf` 带出 `code`——另一个请求、另一个进程、列表轮询都读得到暂停那一刻的原因（宪法二）。
 *
 * `code` 只是标注：库不解释它、不按它做任何分支，也不进续跑状态与签名。`reins.` 前缀留给内置来源
 * （循环的 `MAX_TURNS_PAUSE_CODE`、brain 的 budget / compact），靠约定不靠校验——循环分不出一个 Socket 是内置的还是宿主的；
 * 宿主用自己的前缀（如 `acme.credits_exhausted`）。
 *
 * 标注写错不能改变结局：Socket 要求暂停就一定暂停（那是边界动作，也只有暂停才带续跑凭据）。意见里不合规的地方
 * 被改正（码丢掉、reason 退成 host），改正处记一条模型不可见的非终结 `core.error`——不静默，也不把受控暂停变成 error。
 *
 * 这里是口径的唯一一处（真源索引）：格式判定 `isPauseCode` 写入与读取共用；Socket 的暂停意见怎么变成一条中断
 * （`resolveSocketPause`）、中断怎么变成 `run_paused` 里的字段（`pauseDetailOf`），runLoop 与 TanStack 适配器调同一对函数。
 */
import type { ErrorPayload } from "../events/core.js"
import type { Interruption } from "./types.js"

/**
 * 原因码的格式：小写字母或数字开头，其后小写字母 / 数字 / `_` `.` `:` `-`，总长 1～64。
 * 收这么紧是为了让它在下游能直接当标识符用（前端文案键、日志字段、switch 的 case），而不是一句自由文本。
 * 只许收紧不许放宽：读侧对不合规的码判 unknown，放宽之后老版本的读者会把带新码的会话整个判成 unknown（连 awaiting 一起丢），
 * 真要放宽得按"所有实例一起升级、不回滚"对待
 */
export const PAUSE_CODE_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/

/** 写入（循环校验 Socket 给的码）与读取（`runStatusOf` 的形状守卫）共用的格式判定 */
export function isPauseCode(x: unknown): x is string {
  return typeof x === "string" && PAUSE_CODE_RE.test(x)
}

/** 循环自带的轮数兜底（`LoopConfig.maxTurns`）触顶时的原因码 */
export const MAX_TURNS_PAUSE_CODE = "reins.max_turns"

/** Socket 暂停产生的中断：budget / host 两种，可带原因码 */
export type SocketPauseInterruption = Extract<Interruption, { kind: "budget" | "host" }>

export interface SocketPauseResolution {
  /** 按这条中断暂停：`kind` 即暂停原因 */
  interruption: SocketPauseInterruption
  /**
   * 意见里有不合规、已被改正的地方时给出：调用方在暂停之前把它记成一条非终结的 `core.error`（模型不可见）。
   * 全合规时没有这个字段
   */
  error?: ErrorPayload
}

/** 报错里复述宿主给的值：字符串截到 80 字符（免得一段长文本把报错撑爆），其余只说类型 */
function describeValue(value: unknown): string {
  if (typeof value !== "string") return value === null ? "null" : typeof value
  return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value)
}

/**
 * Socket 的暂停意见 → 一条中断：补上缺省 note，校验 reason 与 code。永不抛错、永远给得出一条可暂停的中断：
 * - `reason` 不是 budget / host（JS 宿主想自定义原因时最容易这么写）→ 按 host 暂停。照原样写进 `run_paused` 的话
 *   `runStatusOf` 只能判 unknown，自定义原因该放进 `code`；
 * - `code` 不满足 `isPauseCode` → 丢掉，不合规的码不进时间线。
 * 入参按 unknown 对待：类型挡得住 TS 宿主，挡不住 JS 宿主与运行时算出来的码
 */
export function resolveSocketPause(pause: {
  reason: unknown
  code?: unknown
  note?: string
}): SocketPauseResolution {
  const problems: string[] = []
  let kind: SocketPauseInterruption["kind"]
  if (pause.reason === "budget" || pause.reason === "host") {
    kind = pause.reason
  } else {
    kind = "host"
    problems.push(
      `pause.reason must be "budget" or "host", got ${describeValue(pause.reason)}; paused with reason "host" instead.`,
    )
  }
  let code: string | undefined
  if (isPauseCode(pause.code)) {
    code = pause.code
  } else if (pause.code !== undefined) {
    problems.push(
      `pause.code must match ${PAUSE_CODE_RE.source}, got ${describeValue(pause.code)}; the code was dropped.`,
    )
  }
  const note = pause.note ?? `a socket requested a pause (${kind})`
  const interruption: SocketPauseInterruption = { kind, note, ...(code !== undefined ? { code } : {}) }
  if (problems.length === 0) return { interruption }
  return {
    interruption,
    error: {
      category: "input",
      message: problems.join(" "),
      retryable: false,
      detail: { phase: "onTurnEnd" },
    },
  }
}

/**
 * 一次暂停的中断列表 → 写进 `core.run_paused` 的原因码与说明：取 budget / host 那一条（一次暂停里至多一条）。
 * 审批 / 客户端工具 / 子代理的暂停没有这一条，返回空对象——它们等的是谁已经在 `awaiting` 里；
 * 子代理自己的原因码不上浮，按 `awaiting[].childSessionId` 查子会话
 */
export function pauseDetailOf(interruptions: readonly Interruption[]): { code?: string; note?: string } {
  for (const i of interruptions) {
    if (i.kind !== "budget" && i.kind !== "host") continue
    return { ...(i.code !== undefined ? { code: i.code } : {}), note: i.note }
  }
  return {}
}
