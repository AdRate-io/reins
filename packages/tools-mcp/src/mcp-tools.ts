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
 */
import { defineTool, REINS_VERSION, type Tool } from "@reinsjs/core"
import { McpConnection } from "./connection.js"
import { modelToolName, riskOf, toContentParts } from "./translate.js"
import type { McpToolInfo, McpToolsOptions, McpToolsSocket } from "./types.js"

export const DEFAULT_CALL_TIMEOUT_MS = 60_000
/** MCP initialize 握手里报给服务器的客户端身份；版本跟随 core，不另维护一份 */
export const REINS_MCP_CLIENT_INFO = { name: "reins", version: REINS_VERSION }

export function mcpTools(options: McpToolsOptions): McpToolsSocket {
  const { transport } = options
  const warn = options.warn ?? ((m: string) => console.warn(m))
  const prefix = options.prefix ?? ""
  const timeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("callTimeoutMs must be a positive number")
  const conn = new McpConnection(transport, { clientInfo: options.clientInfo ?? REINS_MCP_CLIENT_INFO })
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
        const result = await conn.callTool(info.name, args, {
          timeoutMs,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        return { content: toContentParts(result), isError: result.isError === true }
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
    close: () => conn.close(),
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
