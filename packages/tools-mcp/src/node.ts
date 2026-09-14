/**
 * @reinsjs/tools-mcp/node —— stdio 传输配方：起一个子进程当 MCP 服务器。
 * 只有这个子路径带 Node 依赖（SDK 的 stdio 入口用 node:process / node:stream / cross-spawn）；主入口保持纯 Web 标准。
 */
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import type { McpTransport } from "./types.js"

export interface StdioTransportOptions {
  command: string
  args?: string[]
  /** 子进程环境；缺省只继承 SDK 认为安全的少数变量（PATH、HOME 等），密钥要显式传 */
  env?: Record<string, string>
  cwd?: string
  /** 子进程 stderr 去哪：缺省 "inherit"（打到宿主 stderr），"pipe" / "ignore" 同 child_process */
  stderr?: "inherit" | "pipe" | "ignore"
}

export function stdioTransport(options: StdioTransportOptions): McpTransport {
  const label = [options.command, ...(options.args ?? [])].join(" ")
  return {
    kind: "stdio",
    label,
    create: () =>
      new StdioClientTransport({
        command: options.command,
        ...(options.args ? { args: options.args } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.stderr ? { stderr: options.stderr } : {}),
      }),
  }
}

export type { McpTransport } from "./types.js"
