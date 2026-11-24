/**
 * 一条 MCP 连接的生命周期：懒建、跨 run 复用、断了下次需要时按配方重建一次、宿主可关。
 *
 * 为什么不在这里做重连策略（退避、次数）：库里的连接是给"多次 run 复用"的，一次 `tools/call` 失败就让模型
 * 看到 isError 自己决定要不要再试（宪法一）；跨 run 的"重建一次"只是把"上次断了"这个状态清掉，
 * 不是重试。真要保活、要退避的宿主自己包一层 transport。
 *
 * "断了"有两种信号：传输关闭（`onclose`，stdio 子进程退出、内存传输关闭）与 HTTP 会话失效（有状态的 Streamable HTTP
 * 服务器重启或会话过期后对带旧 `mcp-session-id` 的请求回 404）。SDK 对后者只抛 `SdkHttpError`、不触发 `onclose`、也不自己
 * 重新 initialize，而 spec 要求客户端此时开新会话——所以这里认出 404 后把连接作废，交给下一次 `ensure()` 重建。
 */
import { Client, SdkHttpError, type Transport } from "@modelcontextprotocol/client"
import type { McpCallResult } from "./translate.js"
import { toToolInfo } from "./translate.js"
import { type McpToolInfo, McpToolsError, type McpTransport } from "./types.js"

export interface McpConnectionOptions {
  clientInfo: { name: string; version: string }
}

export class McpConnection {
  private client: Client | undefined
  private connecting: Promise<Client> | undefined

  constructor(
    readonly transport: McpTransport,
    private readonly options: McpConnectionOptions,
  ) {}

  /** 当前是否持有一条活连接（测试与排错用） */
  get connected(): boolean {
    return this.client !== undefined
  }

  /** 拿到已连接的 Client：没有就建；正在建就等同一次；上次断了（onclose 已清掉）就重建 */
  private async ensure(): Promise<Client> {
    if (this.client) return this.client
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const client = new Client(this.options.clientInfo)
      try {
        await client.connect(this.transport.create() as Transport)
      } catch (err) {
        throw new McpToolsError(
          `Failed to connect to MCP server (${this.transport.label}): ${messageOf(err)}`,
          this.transport.label,
          { cause: err },
        )
      }
      // 传输断开（服务器退出、网络断）：清掉引用，下一次 ensure 重建。不在这里自动重连
      client.onclose = () => {
        if (this.client === client) this.client = undefined
      }
      this.client = client
      return client
    })()
    try {
      return await this.connecting
    } finally {
      this.connecting = undefined
    }
  }

  /**
   * 确保连接已建好（握手完成）。`route` 把握手放进"发出前"那一段：握手期间 run 被中止时请求根本没发出，
   * 调用方据此如实告诉模型"没发出"，而不是让 SDK 在发请求处抛错、被循环写成"结果未知"
   */
  async ready(): Promise<void> {
    await this.ensure()
  }

  /**
   * 把这条连接作废（会话已失效）：清掉引用让下一次 `ensure()` 重建，旧 Client 尽力关掉。
   * 只在引用仍指向它时清：并发的几次调用同时撞 404，后到的不能把先到者刚重建的新连接清掉
   */
  private discard(client: Client): void {
    if (this.client === client) this.client = undefined
    client.close().catch(() => {
      // 旧连接关不掉也无所谓：它的会话在服务端已经不存在了
    })
  }

  /**
   * `tools/list`（SDK 会自动翻完全部分页）。绕过 SDK 的列表缓存：每次 run 起步要的就是服务器此刻的表。
   * 撞会话失效（404）时在同一次调用里重新握手、再 list 一次——只读请求，重放无副作用；再失败就照常抛
   */
  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    let result: { tools: unknown[] }
    try {
      try {
        result = await this.listOnce(signal)
      } catch (err) {
        if (!isSessionGone(err)) throw err
        result = await this.listOnce(signal)
      }
    } catch (err) {
      // 建连失败已是 McpToolsError（带"Failed to connect"），原样抛
      if (err instanceof McpToolsError) throw err
      throw new McpToolsError(
        `MCP tools/list failed (${this.transport.label}): ${messageOf(err)}`,
        this.transport.label,
        { cause: err },
      )
    }
    return result.tools.map(toToolInfo)
  }

  private async listOnce(signal: AbortSignal | undefined): Promise<{ tools: unknown[] }> {
    const client = await this.ensure()
    try {
      return await client.listTools({}, { cacheMode: "bypass", ...(signal ? { signal } : {}) })
    } catch (err) {
      if (isSessionGone(err)) this.discard(client)
      throw err
    }
  }

  /**
   * `tools/call`。抛错（未知工具、断连、超时）交给调用方翻成 isError 结果。
   * 撞会话失效（404）只把连接作废、照常抛，不在这里重建后重发：写操作重放的判断交给模型，下一次调用自然重建
   */
  async callTool(
    name: string,
    args: unknown,
    opts: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<McpCallResult> {
    const client = await this.ensure()
    try {
      const result = await client.callTool(
        { name, arguments: (args ?? {}) as Record<string, unknown> },
        { timeout: opts.timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) },
      )
      return result as McpCallResult
    } catch (err) {
      if (isSessionGone(err)) this.discard(client)
      throw err
    }
  }

  /**
   * 关掉当前连接（宿主热轮换 Socket、进程收尾）。
   * 正在建连时调用：等这次建连有结果再关——否则 `ensure()` 完成后会把新 Client 挂回 `this.client`，
   * 连接泄漏、`onclose` 回调悬挂（2026-09-10 审查修）。建连失败本来就没有连接，吞掉那个错误。
   */
  async close(): Promise<void> {
    if (this.connecting) {
      try {
        await this.connecting
      } catch {
        // 建连失败：没有连接可关
      }
    }
    const client = this.client
    this.client = undefined
    if (client) await client.close()
  }
}

/**
 * 服务端说"这个会话不存在了"：Streamable HTTP 对带 `mcp-session-id` 的请求回 404（spec：客户端须开新会话）。
 * 不看正文：服务器回什么 JSON-RPC 错误码各家不一，状态码是 spec 定的判据
 */
function isSessionGone(err: unknown): boolean {
  return SdkHttpError.isInstance(err) && err.status === 404
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
