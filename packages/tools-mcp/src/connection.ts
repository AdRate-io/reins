/**
 * 一条 MCP 连接的生命周期：懒建、跨 run 复用、断了下次需要时按配方重建一次、宿主可关。
 *
 * 为什么不在这里做重连策略（退避、次数）：库里的连接是给"多次 run 复用"的，一次 `tools/call` 失败就让模型
 * 看到 isError 自己决定要不要再试（宪法一）；跨 run 的"重建一次"只是把"上次断了"这个状态清掉，
 * 不是重试。真要保活、要退避的宿主自己包一层 transport。
 */
import { Client, type Transport } from "@modelcontextprotocol/client"
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
          `MCP 服务器连接失败（${this.transport.label}）：${messageOf(err)}`,
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

  /** `tools/list`（SDK 会自动翻完全部分页）。绕过 SDK 的列表缓存：每次 run 起步要的就是服务器此刻的表 */
  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const client = await this.ensure()
    let result: { tools: unknown[] }
    try {
      result = await client.listTools({}, { cacheMode: "bypass", ...(signal ? { signal } : {}) })
    } catch (err) {
      throw new McpToolsError(
        `MCP tools/list 失败（${this.transport.label}）：${messageOf(err)}`,
        this.transport.label,
        { cause: err },
      )
    }
    return result.tools.map(toToolInfo)
  }

  /** `tools/call`。抛错（未知工具、断连、超时）交给调用方翻成 isError 结果 */
  async callTool(
    name: string,
    args: unknown,
    opts: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<McpCallResult> {
    const client = await this.ensure()
    const result = await client.callTool(
      { name, arguments: (args ?? {}) as Record<string, unknown> },
      { timeout: opts.timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) },
    )
    return result as McpCallResult
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
