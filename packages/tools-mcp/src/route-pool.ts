/**
 * `route` 的连接池：同一台服务器、按凭据键各一条连接（AdRate 建议 14，方案 `2026-11-19-MCP按调用选凭据`）。
 *
 * 每个键的连接与目录连接同一套生命周期（懒建、跨 run 复用、断了按配方重建一次），由 `McpConnection` 负责；
 * 本文件只管"键 → 连接"与淘汰。两条不变式：
 * - `acquire` 是同步的：取项与在途计数 +1 之间没有 await。否则被 evict 移出的旧项可能在池外被用上，
 *   同一键的并发首调用也会各建一条连接。
 * - evict 不掐断在途调用：SDK 的 `Client.close()` 会中止该传输上在途的 fetch，而此时 run 的 signal 没中止，
 *   循环会写"失败"，写请求却可能已到服务器——模型一重试就是重复写。所以先移出、等在途归零再关。
 */
import { McpConnection, type McpConnectionOptions } from "./connection.js"
import type { McpRoute, McpTransport } from "./types.js"

export interface PoolEntry {
  readonly conn: McpConnection
  /** 正在这条连接上进行的 `tools/call` 数 */
  inflight: number
  /** 已被 evict 移出、等在途归零后关：归零时调 */
  onDrained?: () => void
}

export class RoutePool {
  private readonly entries = new Map<string, PoolEntry>()
  /** 已被 evict 移出、还在等在途归零的项。`closeAll` 收摊时一并关掉，否则它们会拖到 evict 自己关为止 */
  private readonly draining = new Set<PoolEntry>()

  constructor(
    private readonly route: McpRoute,
    private readonly options: McpConnectionOptions,
  ) {}

  /**
   * 取该键的池项并占一个在途名额（同步，见文件头）；调用方必须在 `finally` 里 `release`。
   * 没有就按 `transportFor(key)` 新建；它抛错或返回不合规时不入池，原样抛出（下次再路由到该键会重新调）
   */
  acquire(key: string): PoolEntry {
    let entry = this.entries.get(key)
    if (!entry) {
      const transport = this.route.transportFor(key)
      if (!isTransport(transport))
        throw new TypeError(`route.transportFor must return an McpTransport, got ${kindOf(transport)}`)
      entry = { conn: new McpConnection(transport, this.options), inflight: 0 }
      this.entries.set(key, entry)
    }
    entry.inflight++
    return entry
  }

  release(entry: PoolEntry): void {
    entry.inflight--
    if (entry.inflight === 0) entry.onDrained?.()
  }

  /** 立即移出，等在途调用结束再关。同一键连调两次时第二次立即返回（项已不在池里） */
  async evict(key: string): Promise<void> {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.draining.add(entry)
    try {
      if (entry.inflight > 0)
        await new Promise<void>((resolve) => {
          entry.onDrained = resolve
        })
      await entry.conn.close()
    } finally {
      this.draining.delete(entry)
    }
  }

  /**
   * 收摊：关掉池里全部连接（含正在等在途归零的被 evict 项）、清空池，不等在途调用（与 `McpToolsSocket.close` 同义）。
   * 被 evict 项之后在 evict 里再关一次是无操作（`McpConnection.close` 幂等）。全部尝试后有失败抛第一个
   */
  async closeAll(): Promise<void> {
    const conns = [...this.entries.values(), ...this.draining].map((e) => e.conn)
    this.entries.clear()
    const results = await Promise.allSettled(conns.map((c) => c.close()))
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected")
    if (failed) throw failed.reason
  }
}

function isTransport(value: unknown): value is McpTransport {
  if (typeof value !== "object" || value === null) return false
  const t = value as Record<string, unknown>
  return typeof t.create === "function" && typeof t.label === "string"
}

/** 报错文案里的 "got …"：空串与 null 单独说，其余按 typeof */
export function kindOf(value: unknown): string {
  if (value === null) return "null"
  if (value === "") return "an empty string"
  return typeof value
}
