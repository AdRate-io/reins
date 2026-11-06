/**
 * 补发带续跑状态（AdRate 建议 8）：等审批的会话关页 / 刷新 / 换设备回来，GET 补发的 end 帧交出暂停那一刻签好的状态，
 * 客户端拿它照常 resume。只有会话末尾正是带状态的 run_paused 时才给；状态被别处用掉后，现有校验 fail-closed
 */
import {
  type CoreEvent,
  createCoreEvent,
  createCoreRegistry,
  defineTool,
  type Event,
  InMemoryEventLog,
  type RunResult,
  type SerializedRunState,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, type ScriptedTurn, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { createAgentHandler } from "./handler.js"
import { InMemoryRunRegistry } from "./runs.js"
import { type Frame, gate, getRequest, openReader, parseFrames, postRequest } from "./test-utils.js"
import type { AgentDefinition } from "./types.js"

const MODEL = { provider: "scripted", id: "scripted" }
const SECRET = "k"

/** 每轮都先要一次审批的写操作，批了才回答 */
const SCRIPT: ScriptedTurn[] = [
  { drafts: [callTool("c1", "deploy", { env: "prod" })] },
  { drafts: [say("上线完成")] },
]

function setup(opts: { log?: InMemoryEventLog; executeGate?: Promise<void> } = {}) {
  const log = opts.log ?? new InMemoryEventLog()
  const deploy = defineTool<{ env: string }>({
    name: "deploy",
    description: "上线",
    inputSchema: { type: "object" },
    needsApproval: true,
    execute: async ({ env }) => {
      await opts.executeGate
      return `已上线 ${env}`
    },
  })
  const agent: AgentDefinition = {
    log,
    lowering: new ScriptedLowering(SCRIPT),
    model: MODEL,
    tools: [deploy],
    secret: SECRET,
  }
  const handler = createAgentHandler(agent, { heartbeatMs: 0, runs: new InMemoryRunRegistry() })
  return { log, handler }
}

const resultOf = (frames: Frame[]) => frames.find((f) => f.event === "result")?.data as RunResult | undefined
const endOf = (frames: Frame[]) =>
  frames.find((f) => f.event === "end")?.data as
    | { sessionId: string; lastSeq: number; state?: SerializedRunState }
    | undefined

async function pausedSession(handler: (r: Request) => Promise<Response>) {
  const frames = parseFrames(await (await handler(postRequest({ sessionId: "s1", input: "上线" }))).text())
  const result = resultOf(frames)
  if (result?.status !== "paused") throw new Error(`expected paused, got ${result?.status}`)
  return result
}

const approve = (state: unknown) =>
  postRequest({ sessionId: "s1", resume: state, decisions: [{ toolCallId: "c1", approved: true, by: "u" }] })

describe("补发带续跑状态（AdRate 建议 8）", () => {
  it("等审批的会话 GET 补发：end 带的 state 与当时 live result 的逐字相同，拿它续跑走到 done", async () => {
    const { handler } = setup()
    const live = await pausedSession(handler)

    const frames = parseFrames(await (await handler(getRequest({ sessionId: "s1" }))).text())
    const end = endOf(frames)
    expect(end).toEqual({ sessionId: "s1", lastSeq: live.lastSeq, state: live.state })

    const resumed = parseFrames(await (await handler(approve(end?.state))).text())
    expect(resultOf(resumed)?.status).toBe("done")
  })

  it("客户端 lastSeq 已在末尾、一条不用补发：end 照样带 state（lastSeq 报大了也钳到末尾）", async () => {
    const { handler } = setup()
    const live = await pausedSession(handler)
    for (const lastSeq of [live.lastSeq, live.lastSeq + 5]) {
      const frames = parseFrames(
        await (await handler(getRequest({ sessionId: "s1", lastSeq: String(lastSeq) }))).text(),
      )
      expect(frames.filter((f) => f.id !== undefined)).toEqual([])
      expect(endOf(frames)).toEqual({ sessionId: "s1", lastSeq: live.lastSeq, state: live.state })
    }
  })

  it("续跑完再 GET：末尾不是 run_paused，end 不带 state；旧状态再交 → 409 pending_mismatch", async () => {
    const { handler } = setup()
    const live = await pausedSession(handler)
    expect(resultOf(parseFrames(await (await handler(approve(live.state))).text()))?.status).toBe("done")

    const end = endOf(parseFrames(await (await handler(getRequest({ sessionId: "s1" }))).text()))
    expect(end).toBeDefined()
    expect(end && "state" in end).toBe(false)

    const stale = await handler(approve(live.state))
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: string }).error).toBe("pending_mismatch")
  })

  it("两个窗口拿到同一份状态：一个在续跑时另一个 409 run_in_progress，工具只执行一次", async () => {
    const g = gate()
    const { handler, log } = setup({ executeGate: g.wait() })
    await pausedSession(handler)
    const state = endOf(parseFrames(await (await handler(getRequest({ sessionId: "s1" }))).text()))?.state

    const first = await openReader(handler(approve(state)))
    await first.until((f) => (f.data as CoreEvent | undefined)?.type === "core.tool_started")
    const second = await handler(approve(state))
    expect(second.status).toBe(409)
    expect(((await second.json()) as { error: string }).error).toBe("run_in_progress")
    g.open()
    expect(resultOf(await first.rest())?.status).toBe("done")

    const results: Event[] = []
    for await (const e of log.read("s1")) if (e.type === "core.tool_result") results.push(e)
    expect(results).toHaveLength(1)
  })

  it("补发读完后日志末尾又往前走了（别处续跑的事件刚落）：end 不带 state，lastSeq 与 state 不说两个时刻", async () => {
    const registry = createCoreRegistry()
    /** 第二次 tail（补发读完后的复核）前插进一条事件，模拟并发写入 */
    class RacingLog extends InMemoryEventLog {
      armed = false
      private calls = 0
      override async tail(sessionId: string, n: number): Promise<Event[]> {
        if (this.armed && ++this.calls === 2) {
          const [last] = await super.tail(sessionId, 1)
          await this.append([
            createCoreEvent(registry, {
              type: "core.run_resumed",
              actor: "host",
              payload: {},
              sessionId,
              seq: (last?.seq ?? 0) + 1,
              at: 0,
              id: "racing",
            }),
          ])
        }
        return super.tail(sessionId, n)
      }
    }
    const log = new RacingLog()
    const { handler } = setup({ log })
    const live = await pausedSession(handler)
    log.armed = true
    const end = endOf(parseFrames(await (await handler(getRequest({ sessionId: "s1" }))).text()))
    expect(end?.lastSeq).toBe(live.lastSeq)
    expect(end && "state" in end).toBe(false)
  })

  it("停止之后：末尾是停止收尾写的 run_paused(host)，end 带的是这一份，pendingToolCallIds 为空（不该画审批卡）", async () => {
    const { handler } = setup()
    const live = await pausedSession(handler)
    const stop = await handler(postRequest({ sessionId: "s1", stop: true }))
    expect(stop.status).toBe(200)
    await stop.json()
    // 空闲会话的停止收尾 run 由 handler 自己驱动，等它落完
    let end = endOf(parseFrames(await (await handler(getRequest({ sessionId: "s1" }))).text()))
    for (let i = 0; i < 20 && end?.state?.pendingToolCallIds.length !== 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
      end = endOf(parseFrames(await (await handler(getRequest({ sessionId: "s1" }))).text()))
    }
    expect(end?.lastSeq).toBeGreaterThan(live.lastSeq)
    expect(end?.state).toMatchObject({ sessionId: "s1", lastSeq: end?.lastSeq, pendingToolCallIds: [] })
    // 拿暂停时那份旧状态来批 → 409，工具不执行
    expect((await handler(approve(live.state))).status).toBe(409)
  })

  it("已追平的客户端、末尾是未登记的 ext.* 事件：照旧正常 end，不因复核末尾变成 error 帧", async () => {
    const { handler, log } = setup()
    const live = await pausedSession(handler)
    const seq = live.lastSeq + 1
    await log.append([
      {
        id: "x",
        sessionId: "s1",
        seq,
        at: 0,
        type: "ext.host_note",
        actor: "host",
        schemaVersion: 1,
        payload: {},
      } as Event,
    ])
    const frames = parseFrames(
      await (await handler(getRequest({ sessionId: "s1", lastSeq: String(seq) }))).text(),
    )
    expect(frames.some((f) => f.event === "error")).toBe(false)
    expect(endOf(frames)).toEqual({ sessionId: "s1", lastSeq: seq })
  })

  it("从没暂停过的会话（跑完 / 没有）：end 不带 state", async () => {
    const { handler } = setup()
    const end = endOf(parseFrames(await (await handler(getRequest({ sessionId: "nope" }))).text()))
    expect(end).toEqual({ sessionId: "nope", lastSeq: 0 })
  })
})
