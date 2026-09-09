/**
 * 模型调用的有限重试（E3 后续）：判定"这次失败是不是瞬断"与退避间隔。纯函数，无副作用。
 *
 * 为什么要有：E3 的 99 格里 3 次上游中途掐断（pi-ai 报 "terminated"、输出 0 token），runLoop 直接记 error 结束，
 * 宿主除了整格重跑没别的办法。瞬断是网络与厂商的常态，循环该自己扛几次再交给宿主。
 *
 * 边界（DECISIONS）：
 * - 只在**本次尝试还没写进任何模型输出**时重试。时间线只追加，已落了半截思考 / 正文再让模型重说一遍，日志里就有两份半截，
 *   下游（UI、eval）得自己猜哪份算。半截后失败照旧记 error 交宿主，只是 `retryable` 如实标注。
 * - 宿主中止（AbortSignal）永不重试；配置错（缺 key、不支持的协议、请求翻译不出）永不重试。
 * - 每次将要重试的失败都记一条 `core.error`（retryable=true、detail.willRetry），模型看不见（运维事件），宿主与 eval 看得见。
 */
import { LoweringError } from "../lowering/errors.js"

export interface RetryOptions {
  /** 最多尝试几次（含第一次）。缺省 3；1 = 不重试 */
  maxAttempts?: number
  /** 首次重试前等多久（毫秒），之后每次翻倍。缺省 1000 */
  baseDelayMs?: number
  /** 单次等待上限（毫秒）。缺省 8000 */
  maxDelayMs?: number
  /** 覆盖瞬断判定：返回 true 表示值得重试。缺省见 isTransientFailure */
  isTransient?: (failure: ModelCallFailure) => boolean
  /** 测试注入：等待实现。缺省 setTimeout，且被 signal 中止时提前结束 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** 一次模型调用失败的两种形态：降级层抛了异常，或流正常收尾但 stopReason = error */
export type ModelCallFailure = { kind: "thrown"; error: unknown } | { kind: "outcome"; message: string }

export const DEFAULT_RETRY_MAX_ATTEMPTS = 3
export const DEFAULT_RETRY_BASE_DELAY_MS = 1000
export const DEFAULT_RETRY_MAX_DELAY_MS = 8000

/**
 * 明显是瞬断的信号：网络层错误码、连接被掐、超时、厂商过载 / 限流 / 5xx。
 * 有意保守：判不出来就当**不是**瞬断 —— 重试一个 400 只会再挨一次 400，还多等几秒。
 */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENOTFOUND|ENETUNREACH|ECONNABORTED)\b/,
  /\bterminated\b/i,
  /connection (error|closed|reset|refused)/i,
  /socket hang up/i,
  /\bfetch failed\b/i,
  /\b(timeout|timed out)\b/i,
  /\boverloaded\b/i,
  /rate[ _-]?limit/i,
  /too many requests/i,
  /temporarily unavailable/i,
  /\b(408|409|425|429|500|502|503|504|529)\b/,
  /\bstream (ended|closed) (before|prematurely)/i,
  /pi-ai 流在 done \/ error 之前就结束了/,
]

/** 明确不该重试的：宿主中止、降级层配置错 */
function isDefinitelyPermanent(err: unknown): boolean {
  if (err instanceof LoweringError) return true
  const name = (err as { name?: unknown } | null)?.name
  return name === "AbortError"
}

export function isTransientFailure(failure: ModelCallFailure): boolean {
  if (failure.kind === "thrown") {
    if (isDefinitelyPermanent(failure.error)) return false
    const err = failure.error as { message?: unknown; code?: unknown; name?: unknown; cause?: unknown } | null
    const parts = [
      err?.message,
      err?.code,
      err?.name,
      (err?.cause as { message?: unknown; code?: unknown } | null)?.message,
      (err?.cause as { code?: unknown } | null)?.code,
    ].filter((p): p is string => typeof p === "string")
    return TRANSIENT_PATTERNS.some((re) => parts.some((p) => re.test(p)))
  }
  return TRANSIENT_PATTERNS.some((re) => re.test(failure.message))
}

/** 第 attempt 次失败后等多久：base × 2^(attempt−1)，封顶 maxDelay。不加抖动，保证可测、可回放 */
export function backoffDelayMs(
  attempt: number,
  opts: Pick<RetryOptions, "baseDelayMs" | "maxDelayMs"> = {},
): number {
  const base = opts.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
  const max = opts.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS
  return Math.min(max, base * 2 ** Math.max(0, attempt - 1))
}

/** 缺省等待：setTimeout；signal 中止就立刻返回（由调用方检查 aborted 再决定怎么收尾） */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener("abort", done)
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}

export interface ResolvedRetry {
  maxAttempts: number
  delayFor: (attempt: number) => number
  isTransient: (failure: ModelCallFailure) => boolean
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
}

export function resolveRetry(opts: RetryOptions = {}): ResolvedRetry {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`retry.maxAttempts 必须是 ≥1 的整数：${String(maxAttempts)}`)
  }
  return {
    maxAttempts,
    delayFor: (attempt) => backoffDelayMs(attempt, opts),
    isTransient: opts.isTransient ?? isTransientFailure,
    sleep: opts.sleep ?? defaultSleep,
  }
}
