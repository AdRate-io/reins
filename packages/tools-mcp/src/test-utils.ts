/**
 * 测试辅助：一台可随时加减工具的内存 MCP 服务器，以及把它接成 `McpTransport` 的配方。
 * 内存传输（`InMemoryTransport.createLinkedPair`）走的是完整 JSON-RPC 协议，只是不过网络；
 * `create()` 每次都造一对新的并把服务端那一半接上 —— 正好覆盖"断了重建"的路径。
 */
import { InMemoryTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import type { McpTransport } from "./types.js"

export interface FixtureServer {
  server: McpServer
  transport: McpTransport
  /** 每个 create() 造出的服务端传输，测试里用它模拟服务器掉线 */
  serverTransports: InMemoryTransport[]
  /** 成功建连的次数（重连次数 = 次数 − 1） */
  readonly connects: number
  /** 置 true 模拟"服务器进程不在了"：之后的 create() 直接抛错 */
  down: boolean
}

/**
 * 服务器自带四个工具：
 * - echo（readOnlyHint）：原样回 `echo:<text>`
 * - drop_table（destructiveHint）：回 "dropped <table>"
 * - flaky：入参 fail=true 时回 isError 结果
 * - big：回 `lines` 行文本（给 spill 用）
 */
export function fixtureServer(label = "memory"): FixtureServer {
  const server = new McpServer(
    { name: "reins-fixture", version: "0.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  )
  server.registerTool(
    "echo",
    {
      description: "Echo the text back",
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
  )
  server.registerTool(
    "drop_table",
    {
      description: "Drop a database table",
      inputSchema: { table: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ table }) => ({ content: [{ type: "text", text: `dropped ${table}` }] }),
  )
  server.registerTool(
    "flaky",
    { description: "Fails on demand", inputSchema: { fail: z.boolean() } },
    async ({ fail }) =>
      fail
        ? { content: [{ type: "text", text: "server says: failed on purpose" }], isError: true }
        : { content: [{ type: "text", text: "fine" }] },
  )
  server.registerTool(
    "big",
    { description: "Return many lines", inputSchema: { lines: z.number() } },
    async ({ lines }) => ({
      content: [
        {
          type: "text",
          text: Array.from({ length: lines }, (_, i) => `line ${i + 1}: ${"x".repeat(60)}`).join("\n"),
        },
      ],
    }),
  )

  const serverTransports: InMemoryTransport[] = []
  let connects = 0
  const fixture = {
    down: false,
  }
  const transport: McpTransport = {
    kind: "custom",
    label,
    create: () => {
      if (fixture.down) throw new Error("ECONNREFUSED (fixture server is down)")
      connects++
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      serverTransports.push(serverSide)
      // 服务端连接是异步的；内存传输会把客户端先发的 initialize 排队，等这边接上再送达
      void server.connect(serverSide)
      return clientSide
    },
  }
  return {
    server,
    transport,
    serverTransports,
    get connects() {
      return connects
    },
    get down() {
      return fixture.down
    },
    set down(v: boolean) {
      fixture.down = v
    },
  }
}
