/**
 * Streamable HTTP 传输配方（主入口，纯 Web 标准：只用 fetch / URL / Headers）。
 * 鉴权最简单的做法是 `headers: { Authorization: "Bearer …" }`；OAuth 流程 0.1 不封装，宿主可自带 `fetch` 包一层。
 */
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { McpTransport } from "./types.js"

export interface HttpTransportOptions {
  url: string | URL
  /** 每个请求附带的头（鉴权等） */
  headers?: Record<string, string>
  /** 自定义 fetch（代理、测试里直连内存服务器） */
  fetch?: typeof fetch
  /** 其余 RequestInit 字段（headers 之外） */
  requestInit?: Omit<RequestInit, "headers">
}

export function httpTransport(options: HttpTransportOptions): McpTransport {
  const url = options.url instanceof URL ? options.url : new URL(options.url)
  // 标签只留主机与路径：查询串里常见 token，不进日志
  const label = `${url.origin}${url.pathname}`
  return {
    kind: "http",
    label,
    create: () =>
      new StreamableHTTPClientTransport(url, {
        requestInit: { ...options.requestInit, ...(options.headers ? { headers: options.headers } : {}) },
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
  }
}
