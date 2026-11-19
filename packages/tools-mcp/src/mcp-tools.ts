/**
 * `mcpTools(options): Socket` —— 把一台 MCP 服务器接成 reins 的一个 Socket（技术方案 §10，任务 P1）。
 *
 * 形状刻意最小：只用 Socket 的静态贡献 `tools`（异步函数），一个钩子都不挂。
 * - run 起步 `tools/list` 一次 → 每个 MCP 工具翻成 reins `Tool`，整个 run 工具表不变（§9.1 约束 3 / PRD"不做动态注册"）；
 *   服务器中途发 `listChanged` 只影响下一次 run —— 下一次起步再 list 一遍自然拿到新表，循环还会把增删告诉模型（tools_bound）。
 * - `execute` = `tools/call`；结果 content 翻成 ContentPart、`isError` 直通；抛错（未知工具、断连、超时）由循环记成
 *   `tool_result(isError)`，循环不崩。
 * - annotations → `risk` 与 `needsApproval` 缺省（readOnly → low；destructive → high + 要审批；其余 medium）。
 * spill / approval / budget 在 afterTool / beforeTool 上自动生效，MCP 服务器不需要知道 reins（P3）。
 * - 配了 `route` 时：`tools/list` 仍走 `transport`（目录连接），每次 `tools/call` 先问宿主要凭据键、按键从连接池取连接
 *   （route-pool.ts）。路由不进工具表、不进 configHash。
 */
import { defineTool, REINS_VERSION, type Tool } from "@reinsjs/core"
import { McpConnection } from "./connection.js"
import { kindOf, type PoolEntry, RoutePool } from "./route-pool.js"
import { modelToolName, riskOf, toContentParts } from "./translate.js"
import type { McpToolInfo, McpToolsOptions, McpToolsSocket } from "./types.js"

export const DEFAULT_CALL_TIMEOUT_MS = 60_000
/** MCP initialize 握手里报给服务器的客户端身份；版本跟随 core，不另维护一份 */
export const REINS_MCP_CLIENT_INFO = { name: "reins", version: REINS_VERSION }

/**
 * 路由阶段（选凭据、建连握手，还没发出 `tools/call`）run 被中止时给模型的结果。不能让 execute 抛：MCP 工具缺省不可重放，
 * 循环已先写 `tool_started`，中止状态下抛错会被写成"结果未知"，而调用实际没发出——告诉模型的要与事实一致。
 * 前缀与 core 的"没执行"文案同为 `Not executed:`，宿主按前缀判断时口径一致；不复用 `stopTextsOf`：它对非 RunStop 的中止
 * （丢租约等）也说"被用户停止"
 */
export const ROUTE_NOT_SENT_TEXT =
  "Not executed: the run was interrupted before this call was sent to the MCP server."

export function mcpTools(options: McpToolsOptions): McpToolsSocket {
  const { transport } = options
  const warn = options.warn ?? ((m: string) => console.warn(m))
  const prefix = options.prefix ?? ""
  const timeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("callTimeoutMs must be a positive number")
  const route = options.route
  if (route) {
    if (typeof route.keyOf !== "function")
      throw new TypeError(`route.keyOf must be a function, got ${kindOf(route.keyOf)}`)
    if (typeof route.transportFor !== "function")
      throw new TypeError(`route.transportFor must be a function, got ${kindOf(route.transportFor)}`)
  }
  const connectionOptions = { clientInfo: options.clientInfo ?? REINS_MCP_CLIENT_INFO }
  const conn = new McpConnection(transport, connectionOptions)
  const pool = route ? new RoutePool(route, connectionOptions) : undefined
  const warned = new Set<string>()
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return
    warned.add(key)
    warn(message)
  }

  /** 一个 MCP 工具 → reins Tool。名字给模型看的可能被改写，调用时用原名 */
  const toTool = (info: McpToolInfo): Tool => {
    const name = modelToolName(info.name, prefix)
    if (name !== `${prefix}${info.name}`)
      warnOnce(
        `name:${info.name}`,
        `MCP tool name ${info.name} does not meet the model-facing requirements; the name shown to the model is rewritten to ${name}`,
      )
    const risk = riskOf(info.annotations)
    return defineTool<unknown>({
      name,
      description: info.description ?? info.title ?? info.name,
      inputSchema: info.inputSchema,
      risk,
      // 明说破坏性的工具缺省要人点头；循环内置兜底会在没有 Socket 做主时直接转审批
      ...(risk === "high" ? { needsApproval: true } : {}),
      async execute(args, ctx) {
        const callOptions = { timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) }
        if (!route || !pool) {
          const result = await conn.callTool(info.name, args, callOptions)
          return { content: toContentParts(result), isError: result.isError === true }
        }
        // 占了池项就必须 release：在途计数挡住 evict 关连接，直到这次调用结束
        let entry: PoolEntry | undefined
        try {
          // 发出前：问宿主要键、取池项、握手。这一段出任何错都意味着调用没发出
          try {
            const key: unknown = await route.keyOf({ name: info.name, args }, ctx)
            if (typeof key !== "string" || key === "")
              throw new Error(
                `MCP route must return a non-empty credential key for tool ${info.name}, got ${kindOf(key)}; the call was not sent`,
              )
            if (ctx.signal?.aborted) return notSent()
            entry = pool.acquire(key)
            // 新键与 evict 后的第一次调用都要握手：握手期间被中止时请求没发出，SDK 却会在发请求处抛错、被循环写成"结果未知"
            await entry.conn.ready()
            if (ctx.signal?.aborted) return notSent()
          } catch (err) {
            if (ctx.signal?.aborted) return notSent()
            throw err
          }
          // 发出
          const result = await entry.conn.callTool(info.name, args, callOptions)
          return { content: toContentParts(result), isError: result.isError === true }
        } finally {
          if (entry) pool.release(entry)
        }
      },
    })
  }

  return {
    name: `mcp:${transport.label}`,
    transport,
    tools: async () => {
      let infos: McpToolInfo[]
      try {
        infos = await conn.listTools()
      } catch (err) {
        if (!options.optional) throw err
        warnOnce(
          "list",
          `MCP server ${transport.label} is unavailable, so this run carries none of its tools: ${messageOf(err)}`,
        )
        return []
      }
      const tools: Tool[] = []
      for (const info of infos) {
        const tool = toTool(info)
        const overridden = options.override?.(tool, info)
        if (overridden === false) continue
        tools.push(overridden ?? tool)
      }
      return tools
    },
    close: async () => {
      const results = await Promise.allSettled([conn.close(), pool?.closeAll()])
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected")
      if (failed) throw failed.reason
    },
    evict: async (key: string) => {
      await pool?.evict(key)
    },
  }
}

function notSent() {
  return { content: [{ type: "text" as const, text: ROUTE_NOT_SENT_TEXT }], isError: true }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
