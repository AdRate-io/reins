/**
 * 进行中投递客户端配方（server README "Messages during a run"）的可执行版本：README 里的 `send` 与 `delivered` 就是下面两段，
 * 这里把 fetch 接到真 handler 上，走一遍四种应答里的三种（202 / SSE 200 / 409）与送达判据（AdRate 建议 6，2026-11-06）。
 */
import { defineTool, type Event, InMemoryEventLog } from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAgentHandler } from "./handler.js"
import { USER_DELIVERY_SOURCE } from "./mailbox.js"
import { gate, openReader } from "./test-utils.js"

// ---- 配方本体（与 README 逐字一致，改一处要同步另一处）----

/** Send one message; the caller keeps the deliveryId (and reuses it when retrying). */
async function send(endpoint: string, sessionId: string, deliveryId: string, text: string, lastSeq: number) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, input: text, deliveryId, lastSeq }),
  })
  if (res.status === 202) return { kind: "queued" } as const // watch the run's stream for it
  if (res.status === 200) return { kind: "started", stream: res } as const // a new run, read as usual
  if (res.status === 409 || res.status === 429) return { kind: "retry-later" } as const
  throw new Error(`send failed with ${res.status}`)
}

/** Delivered ⟺ the timeline holds the user message carrying this deliveryId. */
const delivered = (events: readonly Event[], deliveryId: string) =>
  events.some(
    (e) =>
      e.type === "core.user_message" &&
      e.provenance?.source === USER_DELIVERY_SOURCE &&
      e.provenance.ref === deliveryId,
  )

// ---- 配方本体结束 ----

const ENDPOINT = "http://test/agent"
const eventsIn = (frames: { event?: string; data: unknown }[]) =>
  frames.filter((f) => f.event === undefined).map((f) => f.data as Event)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("README 配方：进行中投递的客户端", () => {
  it("run 跑着 → queued 且在流里见到；空闲 → started；停止中 → retry-later", async () => {
    const gated = (name: string) => {
      const g = gate()
      const tool = defineTool<Record<string, never>>({
        name,
        description: "等闸门",
        risk: "low",
        inputSchema: { type: "object" },
        execute: async () => {
          await g.wait()
          return "放行"
        },
      })
      return { g, tool }
    }
    const first = gated("wait")
    const second = gated("hold")
    const handler = createAgentHandler(
      {
        log: new InMemoryEventLog(),
        lowering: new ScriptedLowering([
          { drafts: [callTool("c1", "wait", {})] },
          { drafts: [say("好的")] },
          { drafts: [callTool("c2", "hold", {})] },
        ]),
        model: { provider: "scripted", id: "scripted" },
        tools: [first.tool, second.tool],
      },
      { heartbeatMs: 0, midRunInput: true },
    )
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => handler(new Request(url, init)))

    // 空闲：消息起一个新 run
    const started = await send(ENDPOINT, "s1", "d0", "查一下", 0)
    expect(started.kind).toBe("started")
    const stream = started.kind === "started" ? await openReader(started.stream) : undefined
    await stream?.until((f) => (f.data as Event | undefined)?.type === "core.tool_call")

    // run 跑着：入箱，在同一条流里等它出现
    expect((await send(ENDPOINT, "s1", "d1", "只看 A", 3)).kind).toBe("queued")
    first.g.open()
    await stream?.rest()
    const seen = eventsIn(stream?.seen ?? [])
    expect(delivered(seen, "d0")).toBe(true)
    expect(delivered(seen, "d1")).toBe(true)

    // 停止中：稍后重发
    const again = await send(ENDPOINT, "s1", "d2", "再查", 0)
    const busy = again.kind === "started" ? await openReader(again.stream) : undefined
    await busy?.until((f) => (f.data as Event | undefined)?.type === "core.tool_call")
    const wasRunning = await handler(
      new Request(ENDPOINT, { method: "POST", body: JSON.stringify({ sessionId: "s1", stop: true }) }),
    )
    expect(wasRunning.status).toBe(200)
    expect((await send(ENDPOINT, "s1", "d3", "只看 B", 0)).kind).toBe("retry-later")
    second.g.open()
    await busy?.rest()
    const tail = eventsIn(busy?.seen ?? [])
    expect(delivered(tail, "d2")).toBe(true)
    expect(delivered(tail, "d3")).toBe(false)
  })
})
