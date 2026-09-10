// 测试用的 stdio MCP 服务器：一个 echo 工具。`node stdio-server.mjs` 从 stdin 读 JSON-RPC、往 stdout 写。
import { McpServer } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { z } from "zod"

const server = new McpServer({ name: "stdio-fixture", version: "0.0.0" })
server.registerTool("echo", { description: "echo", inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: "text", text: `stdio:${text}` }],
}))
await server.connect(new StdioServerTransport())
