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
import { defineTool, REINS_VERSION, type SocketSetup, type Tool } from "@reinsjs/core"
import { McpConnection } from "./connection.js"
import { kindOf, type PoolEntry, RoutePool } from "./route-pool.js"
import { modelToolName, modelToolNames, riskOf, toContentParts } from "./translate.js"
import type { McpToolInfo, McpToolsOptions, McpToolsSocket } from "./types.js"

export const DEFAULT_CALL_TIMEOUT_MS = 60_000
/** MCP initialize 握手里报给服务器的客户端身份；版本跟随 core，不另维护一份 */
export const REINS_MCP_CLIENT_INFO = { name: "reins", version: REINS_VERSION }

/**
 * 发出前阶段（route 选凭据；有无 route 都有的建连握手——新键、evict 后、断线后重建；还没发出 `tools/call`）run 被中止时
 * 给模型的结果（名字沿用 route 引入时的叫法）。不能让 execute 抛：MCP 工具缺省不可重放，
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

  /**
   * 一个 MCP 工具 → reins Tool。`name` 是 `modelToolNames` 排过撞名的模型侧名字（可能被改写），调用时用原名。
   * 告警按"原名 → 改写名"去重：撞名对象随服务器工具表变化时改写名会变，变了要再说一次
   */
  const toTool = (info: McpToolInfo, name: string): Tool => {
    if (name !== `${prefix}${info.name}`) {
      const plain = modelToolName(info.name, prefix)
      warnOnce(
        `name:${info.name}->${name}`,
        plain === name
          ? `MCP tool name ${info.name} does not meet the model-facing requirements; the name shown to the model is rewritten to ${name}`
          : `MCP tool name ${info.name} is shown to the model as ${name}: ${plain} is already used by another tool on this server`,
      )
    }
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
        // 占了池项就必须 release：在途计数挡住 evict 关连接，直到这次调用结束
        let entry: PoolEntry | undefined
        try {
          let target: McpConnection
          // 发出前：（route 时）问宿主要键、取池项；握手。这一段出任何错都意味着调用没发出
          try {
            if (route && pool) {
              const key: unknown = await route.keyOf({ name: info.name, args }, ctx)
              if (typeof key !== "string" || key === "")
                throw new Error(
                  `MCP route must return a non-empty credential key for tool ${info.name}, got ${kindOf(key)}; the call was not sent`,
                )
              if (ctx.signal?.aborted) return notSent()
              entry = pool.acquire(key)
              target = entry.conn
            } else target = conn
            // 新键、evict 后、断线后重建的第一次调用都要握手：握手期间被中止时请求没发出，
            // SDK 却会在发请求处抛错、被循环写成"结果未知"。连接在时 ready() 立即返回
            await target.ready()
            if (ctx.signal?.aborted) return notSent()
          } catch (err) {
            if (ctx.signal?.aborted) return notSent()
            throw err
          }
          // 发出
          const result = await target.callTool(info.name, args, callOptions)
          return { content: toContentParts(result), isError: result.isError === true }
        } finally {
          if (entry) pool?.release(entry)
        }
      },
    })
  }

  return {
    name: `mcp:${transport.label}`,
    transport,
    // setup 缺省只为直接调用（单测拿工具表）；循环解析时总会传
    tools: async (setup?: SocketSetup) => {
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
      const names = modelToolNames(
        infos.map((i) => i.name),
        prefix,
      )
      for (const [i, info] of infos.entries()) {
        const tool = toTool(info, names[i] as string)
        const overridden = options.override?.(tool, info)
        if (overridden === false) continue
        const bound = overridden ?? tool
        // core 合并工具表时同名先到者赢、后到者静默丢掉：宿主或排在前面的 Socket（如 brain 的 fetch_blob / memory）已占了这个名字，
        // 本服务器这件模型永远看不到。不在这里列 brain 的名字（那是第二份真源），只看此刻真正绑定的表；告警按名字去重
        if (setup?.tools.some((t) => t.name === bound.name)) {
          warnOnce(
            `bound:${bound.name}`,
            `MCP tool ${info.name} from ${transport.label} is not available to the model: the tool table already has a tool named ${bound.name} (from the host or a socket registered before this one), and the first one wins. Give mcpTools() a prefix to keep both.`,
          )
        }
        tools.push(bound)
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
