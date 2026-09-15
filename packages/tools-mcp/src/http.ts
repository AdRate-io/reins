/**
 * Streamable HTTP 传输配方（主入口，纯 Web 标准：只用 fetch / URL / Headers）。
 *
 * 固定令牌用 `headers: { Authorization: "Bearer …" }` 就够。会过期的令牌（OAuth）必须用 `auth`：
 * headers 在构造时就定死了，而连接是懒建、跨 run 复用、断了按同一配方重建的——令牌一过期，重建也是拿旧的。
 * `auth.token()` 每个请求前现取，401 时 `onUnauthorized()` 刷新后自动重试一次（都由 MCP SDK 的传输层做）。
 */
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { McpAuth, McpTransport } from "./types.js"

export interface HttpTransportOptions {
  url: string | URL
  /** 每个请求附带的头（固定令牌等）。会过期的令牌用 `auth`，别写死在这里 */
  headers?: Record<string, string>
  /**
   * 每个请求的 bearer 凭证来源：`token()` 请求前现取、401 走 `onUnauthorized()` 刷新后自动重试一次。
   * 与 `headers.Authorization` 互斥（两者都给在构造期即拒绝：静默让一个盖掉另一个，排查时看不出来）
   */
  auth?: McpAuth
  /** 自定义 fetch（代理、测试里直连内存服务器） */
  fetch?: typeof fetch
  /** 其余 RequestInit 字段（headers 之外） */
  requestInit?: Omit<RequestInit, "headers">
}

/** headers 里的 Authorization（大小写不敏感：HTTP 头名不区分大小写，宿主写 authorization 也算） */
function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false
  return Object.keys(headers).some((k) => k.toLowerCase() === "authorization")
}

export function httpTransport(options: HttpTransportOptions): McpTransport {
  if (options.auth && hasAuthorizationHeader(options.headers)) {
    throw new Error(
      "httpTransport: auth and an Authorization header cannot be used together; keep the token in auth.token() so it is fetched fresh for every request",
    )
  }
  const url = options.url instanceof URL ? options.url : new URL(options.url)
  // 标签只留主机与路径：查询串里常见 token，不进日志
  const label = `${url.origin}${url.pathname}`
  // 包一层而不是直接把 McpAuth 交给 SDK：我们的签名收 MaybePromise，宿主同步返回令牌也行
  const auth = options.auth
  const authProvider = auth
    ? {
        token: async () => await auth.token(),
        ...(auth.onUnauthorized ? { onUnauthorized: async () => void (await auth.onUnauthorized?.()) } : {}),
      }
    : undefined
  return {
    kind: "http",
    label,
    create: () =>
      new StreamableHTTPClientTransport(url, {
        requestInit: { ...options.requestInit, ...(options.headers ? { headers: options.headers } : {}) },
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(authProvider ? { authProvider } : {}),
      }),
  }
}
