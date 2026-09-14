/**
 * 三线共用的 fetch 封装：超时、宿主中止、非 2xx 转成带状态码的错误。
 *
 * 错误文案刻意用 "<status> <body>" 格式（与两家官方 SDK 同款）：core 的瞬断判据（retry.ts）先看错误对象上的
 * `status` / `headers`，再看文案开头的三位数字，所以这里抛出的错误不用任何额外约定就能被正确判成
 * "429 / 5xx 重试、400 不重试"。`headers` 保留原样，`x-should-retry` 由 core 自己读。
 *
 * 不读环境变量、不碰 node:*，Workers / Deno / 浏览器同一份代码。
 */

export class HttpError extends Error {
  override readonly name = "HttpError"
  constructor(
    readonly status: number,
    readonly headers: Headers,
    /** 响应正文原文（厂商错误体或网关信封，不假定形状） */
    readonly body: string,
    readonly url: string,
  ) {
    super(`${status} ${body}`)
  }
}

/** 一次请求的时限（整条响应，含流式读完），与两家 SDK 缺省一致 */
export const DEFAULT_TIMEOUT_MS = 600_000

export interface RequestSignals {
  /** 交给 fetch 与流读取的组合信号 */
  signal: AbortSignal
  /** 中止后判定是哪一方：宿主中止（ctx.signal）还是本地超时 */
  timedOut: () => boolean
}

/**
 * 把宿主的 signal 与本地超时合成一个信号。超时到点后 `timedOut()` 为真；宿主中止优先（两者都发生时算宿主中止，
 * 因为宿主中止是有意为之、不该被当成瞬断重试）。
 */
export function requestSignals(hostSignal: AbortSignal | undefined, timeoutMs: number): RequestSignals {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = hostSignal ? AbortSignal.any([hostSignal, timeout]) : timeout
  return { signal, timedOut: () => timeout.aborted && !hostSignal?.aborted }
}

export interface PostJsonInput {
  url: string
  headers: Record<string, string>
  body: unknown
  signal: AbortSignal
  fetch?: typeof globalThis.fetch
}

/**
 * POST JSON；非 2xx 读完正文抛 HttpError。网络层失败（DNS、连接被掐、超时）由 fetch 自己抛出，原样上抛——
 * 那些错误对象上的 `cause.code` / `name` 正是 core 判瞬断要看的东西，包一层反而会盖掉。
 */
export async function postJson(input: PostJsonInput): Promise<Response> {
  const doFetch = input.fetch ?? globalThis.fetch
  const res = await doFetch(input.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...input.headers },
    body: JSON.stringify(input.body),
    signal: input.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new HttpError(res.status, res.headers, text, input.url)
  }
  return res
}
