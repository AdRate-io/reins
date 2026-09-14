/** `@reinsjs/tools-mcp/node`：起子进程当 MCP 服务器，list + call，close 后子进程结束 */

import { fileURLToPath } from "node:url"
import { type Event, InMemoryEventLog, type RunResult, runLoop } from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { mcpTools } from "./mcp-tools.js"
import { stdioTransport } from "./node.js"

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<Event[]> {
  const events: Event[] = []
  while (true) {
    const step = await gen.next()
    if (step.done) return events
    events.push(step.value)
  }
}

describe("stdioTransport", () => {
  it("子进程服务器：tools/list 与 tools/call 都通；标签是命令行", async () => {
    const script = fileURLToPath(new URL("../test-fixtures/stdio-server.mjs", import.meta.url))
    const transport = stdioTransport({ command: process.execPath, args: [script], stderr: "inherit" })
    expect(transport.kind).toBe("stdio")
    expect(transport.label).toBe(`${process.execPath} ${script}`)

    const socket = mcpTools({ transport })
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "echo", { text: "hi" })] },
      { drafts: [say("ok")] },
    ])
    const events = await drain(
      runLoop({ sessionId: "s", log, lowering, model: { provider: "x", id: "y" }, sockets: [socket] }),
    )
    expect((lowering.requests[0]?.tools ?? []).map((t) => t.name)).toEqual(["echo"])
    const result = events.find((e) => e.type === "core.tool_result") as
      | { payload: { content: { type: string; text?: string }[] } }
      | undefined
    expect(result?.payload.content).toEqual([{ type: "text", text: "stdio:hi" }])
    await socket.close()
  }, 20_000)
})
