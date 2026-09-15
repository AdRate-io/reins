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
 * 判定顺序（R3，2026-09-10）：结构化信息优先，文案关键词只兜底。
 *
 * 1. 明确永久：宿主中止（AbortError / APIUserAbortError）、降级层配置错（LoweringError）。
 * 2. SDK 连接层错误类（APIConnectionError / APIConnectionTimeoutError，两家 SDK 同名）：请求根本没到或没回来，瞬断。
 * 3. 服务端明示：响应头 `x-should-retry: true|false`（两家 SDK 都认）。
 * 4. **HTTP 状态码**：错误对象上的 `status`，或文案开头的三位数字（两家 SDK 的 message 固定是 "<status> <body>"，pi-ai 原样转成
 *    errorMessage），再退到 "status (code) 503" 这类写法。有状态码就**只按状态码定**：408 / 409 / 429 / 5xx 算瞬断（与 SDK 及
 *    pi-ai `provider-retry` 同一策略），其余一律不算——400 的正文里写着 "timeout" 也不重试，重试只会再挨一次 400。
 * 5. 没有状态码才看文案：网络错误码、连接被掐、超时、过载 / 限流。**不再对裸数字匹配**（"429" 出现在 400 正文里的情形就是 R3 的由来）。
 *
 * 判不出来一律当**不是**瞬断。
 */
const TRANSIENT_STATUS = (status: number): boolean =>
  status === 408 || status === 409 || status === 429 || status >= 500

/** Node / undici 的网络层错误码，按 `code` 字段精确匹配 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "ENOTFOUND",
  "ENETUNREACH",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
])

/** 没有状态码时才用的文案兜底：网络层错误码字样、连接被掐、超时、过载 / 限流、流提前结束 */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENOTFOUND|ENETUNREACH|ECONNABORTED|UND_ERR_[A-Z_]+TIMEOUT|UND_ERR_SOCKET)\b/,
  /\bterminated\b/i,
  /connection (error|closed|reset|refused)/i,
  /socket hang up/i,
  /\bfetch failed\b/i,
  /\b(timeout|timed out)\b/i,
  /\boverloaded\b/i,
  /rate[ _-]?limit/i,
  /too many requests/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /\bstream (ended|closed) (before|prematurely)/i,
  /pi-ai 流在 done \/ error 之前就结束了/,
]

/** SDK 连接层错误类名（Anthropic 与 OpenAI SDK 同名） */
const CONNECTION_ERROR_NAMES: ReadonlySet<string> = new Set([
  "APIConnectionError",
  "APIConnectionTimeoutError",
])

/** 明确不该重试的：宿主中止、降级层配置错 */
function isDefinitelyPermanent(err: unknown): boolean {
  if (err instanceof LoweringError) return true
  const name = (err as { name?: unknown } | null)?.name
  return name === "AbortError" || name === "APIUserAbortError"
}

/**
 * 从错误文案里提取 HTTP 状态码：开头的三位数字（SDK 格式 "<status> <body>"），或 "status (code) 503" / "HTTP 503" 写法。
 * 只认 100～599，不在这两个位置上的数字不算（正文里提到 "429" 不是状态码）
 */
export function statusFromMessage(message: string): number | undefined {
  const m = /^\s*(\d{3})\b/.exec(message) ?? /\b(?:status(?:\s+code)?|HTTP)[\s:=]+(\d{3})\b/i.exec(message)
  if (!m?.[1]) return undefined
  const status = Number(m[1])
  return status >= 100 && status <= 599 ? status : undefined
}

interface ErrorShape {
  message?: unknown
  code?: unknown
  name?: unknown
  status?: unknown
  headers?: unknown
  cause?: unknown
}

/** 错误对象与它的 cause 上的结构化字段（SDK 的 APIError 带 status / headers；undici 的网络错误把 code 放 cause 上） */
function structuredOf(error: unknown): {
  status?: number
  code?: string
  name?: string
  shouldRetry?: boolean
  texts: string[]
} {
  const layers: ErrorShape[] = []
  let cur = error as ErrorShape | null
  for (let depth = 0; cur && typeof cur === "object" && depth < 4; depth++) {
    layers.push(cur)
    cur = cur.cause as ErrorShape | null
  }
  const out: ReturnType<typeof structuredOf> = { texts: [] }
  for (const l of layers) {
    if (out.status === undefined && typeof l.status === "number") out.status = l.status
    if (out.code === undefined && typeof l.code === "string") out.code = l.code
    if (out.name === undefined && typeof l.name === "string") out.name = l.name
    if (out.shouldRetry === undefined && l.headers instanceof Headers) {
      const h = l.headers.get("x-should-retry")
      if (h === "true") out.shouldRetry = true
      else if (h === "false") out.shouldRetry = false
    }
    if (typeof l.message === "string") out.texts.push(l.message)
  }
  return out
}

export function isTransientFailure(failure: ModelCallFailure): boolean {
  if (failure.kind === "outcome") {
    const status = statusFromMessage(failure.message)
    if (status !== undefined) return TRANSIENT_STATUS(status)
    return TRANSIENT_PATTERNS.some((re) => re.test(failure.message))
  }
  if (isDefinitelyPermanent(failure.error)) return false
  const info = structuredOf(failure.error)
  if (info.name !== undefined && CONNECTION_ERROR_NAMES.has(info.name)) return true
  if (info.shouldRetry !== undefined) return info.shouldRetry
  const status = info.status ?? info.texts.map(statusFromMessage).find((s) => s !== undefined)
  if (status !== undefined) return TRANSIENT_STATUS(status)
  if (info.code !== undefined && TRANSIENT_CODES.has(info.code)) return true
  return TRANSIENT_PATTERNS.some((re) => info.texts.some((t) => re.test(t)))
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
    throw new RangeError(`retry.maxAttempts must be an integer >= 1, got ${String(maxAttempts)}`)
  }
  return {
    maxAttempts,
    delayFor: (attempt) => backoffDelayMs(attempt, opts),
    isTransient: opts.isTransient ?? isTransientFailure,
    sleep: opts.sleep ?? defaultSleep,
  }
}
