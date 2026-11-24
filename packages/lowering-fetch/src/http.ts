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

/**
 * 本地时限的缺省值。口径（全库审查 #27）：从发出请求到收到响应头，以及流里任意两帧之间的空档，都不得超过它；
 * **不限整条流的总时长**。两家官方 SDK 的 600s 也只管到响应头（fetch resolve 后即 clearTimeout），
 * 长思考 / 长工具入参的流可以合法地跑十几分钟，按总时长掐会把正在出字的流切断、且因已有输出而不重试。
 * 空档时限是本包比 SDK 多的一道：流停住不出帧时不会永远挂着（Anthropic 流有 ping，正常流不会空这么久）。
 */
export const DEFAULT_TIMEOUT_MS = 600_000

export interface RequestSignals {
  /** 交给 fetch 与流读取的组合信号 */
  signal: AbortSignal
  /** 中止后判定是哪一方：宿主中止（ctx.signal）还是本地超时 */
  timedOut: () => boolean
  /** 收到一帧（或响应头）时调：空档计时从此刻重新开始 */
  touch: () => void
  /** 请求结束（读完、出错或调用方提前停止）时调：清掉计时器 */
  dispose: () => void
}

/**
 * 把宿主的 signal 与本地"空档"时限合成一个信号：创建即开始计时，每次 `touch()` 重新计；到点后以
 * TimeoutError（DOMException，与 AbortSignal.timeout 同款，core 判可重试）中止，`timedOut()` 为真。
 * 宿主中止优先（两者都发生时算宿主中止，因为宿主中止是有意为之、不该被当成瞬断重试）。
 */
export function requestSignals(hostSignal: AbortSignal | undefined, timeoutMs: number): RequestSignals {
  const local = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(
      () =>
        local.abort(
          new DOMException(`request timed out: no response data for ${timeoutMs}ms`, "TimeoutError"),
        ),
      timeoutMs,
    )
    // Node 下不让这个计时器单独撑住进程（AbortSignal.timeout 也是如此）；其它运行时没有 unref，跳过
    ;(timer as { unref?: () => void }).unref?.()
  }
  const dispose = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  arm()
  const signal = hostSignal ? AbortSignal.any([hostSignal, local.signal]) : local.signal
  return {
    signal,
    timedOut: () => local.signal.aborted && !hostSignal?.aborted,
    touch: () => {
      if (!local.signal.aborted && timer !== undefined) arm()
    },
    dispose,
  }
}

/**
 * 包住 SSE 消息流：每到一帧 `touch()` 一次，流结束（含出错、调用方提前 return）时 `dispose()`。
 */
export async function* touchEach<T>(source: AsyncIterable<T>, signals: RequestSignals): AsyncGenerator<T> {
  try {
    for await (const item of source) {
      signals.touch()
      yield item
    }
  } finally {
    signals.dispose()
  }
}

export interface PostJsonInput {
  url: string
  headers: Record<string, string>
  body: unknown
  signal: AbortSignal
  fetch?: typeof globalThis.fetch
}

function isJsonContentType(value: string | null): boolean {
  const type = value?.split(";")[0]?.trim().toLowerCase()
  return type === "application/json" || (type?.endsWith("+json") ?? false)
}

/**
 * POST JSON；非 2xx（以及 2xx 但正文明说是 JSON）读完正文抛 HttpError。网络层失败（DNS、连接被掐、超时）由 fetch 自己抛出，原样上抛——
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
  // 2xx 却明说是 JSON：网关 / 中转站把错误（鉴权失败、额度用尽）以 200 + JSON 回。交给 SSE 解析只会得到
  // "流没收尾"、被当瞬断重试且厂商原文丢失（全库审查 #72）。只认明确的 JSON 类型——没写或写错 content-type 的
  // SSE 照旧放行，别误伤
  if (isJsonContentType(res.headers.get("content-type"))) {
    const text = await res.text().catch(() => "")
    throw new HttpError(res.status, res.headers, text, input.url)
  }
  return res
}
