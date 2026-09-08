import { describe, expect, it } from "vitest"
import type { Event } from "../events/base.js"
import { createCoreEvent } from "../events/create.js"
import { CORE_SCHEMAS, createCoreRegistry, EventSchemaRegistry, SchemaError } from "../events/registry.js"
import { InMemoryEventLog } from "../store/in-memory.js"
import { readEvents, readTimeline } from "./read-timeline.js"

/**
 * P9：日志里的事件读出来时按注册表升级；未登记的类型、未来版本一律拒绝。
 * 存储层不认识 schema，这层就是"读时 upcast"发生的地方。
 */

const registry = createCoreRegistry()
const S = "rt"

/** 假装 core.error 升到了 v2：把 message 改名为 text */
function registryWithErrorV2(): EventSchemaRegistry {
  const others = CORE_SCHEMAS.filter((s) => s.type !== "core.error")
  return new EventSchemaRegistry([
    ...others,
    {
      type: "core.error",
      version: 2,
      upcasters: {
        1: (p) => {
          const { message, ...rest } = p as { message: string }
          return { ...rest, text: message }
        },
      },
    },
  ])
}

async function seed(log: InMemoryEventLog, events: Event[]) {
  await log.append(events)
}

describe("readTimeline / readEvents：读时升级，fail-closed", () => {
  it("当前版本的事件原样读出，附带区间参数透传", async () => {
    const log = new InMemoryEventLog()
    const evs = [1, 2, 3].map((seq) =>
      createCoreEvent(registry, {
        type: "core.user_message",
        actor: "user",
        sessionId: S,
        seq,
        at: seq,
        id: `e${seq}`,
        payload: { content: [{ type: "text", text: `第 ${seq} 句` }] },
      }),
    )
    await seed(log, evs)
    expect(await readTimeline(log, S, { registry })).toEqual(evs)
    expect((await readTimeline(log, S, { registry, fromSeq: 2 })).map((e) => e.seq)).toEqual([2, 3])
    const streamed: number[] = []
    for await (const e of readEvents(log, S, { registry, toSeq: 2 })) streamed.push(e.seq)
    expect(streamed).toEqual([1, 2])
  })

  it("旧版本事件按升级链升到当前版本：schemaVersion 与 payload 都变，日志里的原件不动", async () => {
    const log = new InMemoryEventLog()
    const v1 = createCoreEvent(registry, {
      type: "core.error",
      actor: "system",
      sessionId: S,
      seq: 1,
      at: 1,
      id: "e1",
      payload: { category: "tool", message: "旧字段名", retryable: false },
    })
    expect(v1.schemaVersion).toBe(1)
    await seed(log, [v1])

    const [read] = await readTimeline(log, S, { registry: registryWithErrorV2() })
    expect(read?.schemaVersion).toBe(2)
    expect(read?.payload).toEqual({ category: "tool", text: "旧字段名", retryable: false })
    // 只 append 的日志不被"升级"改写：再用 v1 注册表读，还是 v1
    const [again] = await readTimeline(log, S, { registry })
    expect(again?.schemaVersion).toBe(1)
  })

  it("日志里有未登记的 ext.* 事件而注册表不认识：抛 SchemaError(unknown_type)，而不是静默透传", async () => {
    const log = new InMemoryEventLog()
    const ext: Event = {
      id: "x1",
      sessionId: S,
      seq: 1,
      at: 1,
      type: "ext.host_ping",
      schemaVersion: 1,
      actor: "host",
      trust: "system",
      payload: { n: 1 },
    }
    await seed(log, [ext])
    await expect(readTimeline(log, S, { registry })).rejects.toMatchObject({
      name: "SchemaError",
      code: "unknown_type",
    })
    // 登记之后就能读
    const withExt = createCoreRegistry([{ type: "ext.host_ping", version: 1 }])
    expect((await readTimeline(log, S, { registry: withExt }))[0]?.type).toBe("ext.host_ping")
  })

  it("日志里的版本比代码认识的新：拒绝读取（future_version）", async () => {
    const log = new InMemoryEventLog()
    const future = {
      ...createCoreEvent(registry, {
        type: "core.user_message",
        actor: "user",
        sessionId: S,
        seq: 1,
        at: 1,
        id: "e1",
        payload: { content: [] },
      }),
      schemaVersion: 9,
    }
    await seed(log, [future])
    const err = await readTimeline(log, S, { registry }).catch((e) => e)
    expect(err).toBeInstanceOf(SchemaError)
    expect(err.code).toBe("future_version")
  })
})
