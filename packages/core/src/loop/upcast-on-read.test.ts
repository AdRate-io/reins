import { describe, expect, it } from "vitest"
import type { Event } from "../events/base.js"
import { CORE_SCHEMAS, createCoreRegistry, EventSchemaRegistry } from "../events/registry.js"
import { InMemoryEventLog } from "../store/in-memory.js"
import { ScriptedLowering, say } from "../testing/scripted-lowering.js"
import { runLoop } from "./run-loop.js"
import type { LoopConfig, RunResult } from "./types.js"

/**
 * 循环读日志走 readTimeline：模型看到的是升级后的形状；日志里有循环不认识的事件时，一条都不写就拒绝。
 */

const MODEL = { provider: "scripted", id: "scripted" }
const S = "up1"

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<RunResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

/** 假装 user_message 升到 v2：content 外再包一层 { parts, lang } */
function registryWithUserV2(): EventSchemaRegistry {
  return new EventSchemaRegistry([
    ...CORE_SCHEMAS.filter((s) => s.type !== "core.user_message"),
    {
      type: "core.user_message",
      version: 2,
      upcasters: { 1: (p) => ({ ...(p as object), lang: "zh" }) },
    },
  ])
}

const rawUser = (seq: number, text: string): Event => ({
  id: `u${seq}`,
  sessionId: S,
  seq,
  at: seq,
  type: "core.user_message",
  schemaVersion: 1,
  actor: "user",
  trust: "principal",
  payload: { content: [{ type: "text", text }] },
})

function cfg(lowering: ScriptedLowering, log: InMemoryEventLog, extra: Partial<LoopConfig> = {}): LoopConfig {
  return { sessionId: S, log, lowering, model: MODEL, ...extra }
}

describe("runLoop 读日志时按注册表升级（P9）", () => {
  it("日志里的 v1 用户消息，配 v2 注册表跑：模型看到的是升级后的 payload，且用 v2 写新事件", async () => {
    const log = new InMemoryEventLog()
    await log.append([rawUser(1, "老格式的话")])
    const lowering = new ScriptedLowering([{ drafts: [say("收到")] }])
    const registry = registryWithUserV2()
    const result = await drain(runLoop(cfg(lowering, log, { registry })))
    expect(result.status).toBe("done")

    const seen = lowering.requests[0]?.events[0]
    expect(seen?.schemaVersion).toBe(2)
    expect(seen?.payload).toEqual({ content: [{ type: "text", text: "老格式的话" }], lang: "zh" })
    // 日志里的原件仍是 v1（只 append，不改写历史）
    const stored: Event[] = []
    for await (const e of log.read(S)) stored.push(e)
    expect(stored[0]?.schemaVersion).toBe(1)
  })

  it("日志里有循环不认识的 ext.* 事件：抛 SchemaError，一条日志不写", async () => {
    const log = new InMemoryEventLog()
    await log.append([
      rawUser(1, "你好"),
      { ...rawUser(2, ""), id: "x2", type: "ext.host_marker", actor: "host", trust: "system", payload: {} },
    ])
    const lowering = new ScriptedLowering([{ drafts: [say("不该走到这")] }])
    await expect(drain(runLoop(cfg(lowering, log, { input: "再说一句" })))).rejects.toMatchObject({
      name: "SchemaError",
      code: "unknown_type",
    })
    expect(lowering.requests).toHaveLength(0)
    const stored: Event[] = []
    for await (const e of log.read(S)) stored.push(e)
    expect(stored).toHaveLength(2)

    // 登记了就正常跑
    const ok = await drain(
      runLoop(
        cfg(new ScriptedLowering([{ drafts: [say("好的")] }]), log, {
          input: "再说一句",
          registry: createCoreRegistry([{ type: "ext.host_marker", version: 1 }]),
        }),
      ),
    )
    expect(ok.status).toBe("done")
  })
})
