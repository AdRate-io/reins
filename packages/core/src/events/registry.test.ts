import { describe, expect, it } from "vitest"
import type { Event } from "./base.js"
import type { CoreEventOf } from "./core.js"
import { createCoreEvent, createEvent } from "./create.js"
import { CORE_SCHEMAS, createCoreRegistry, EventSchemaRegistry, SchemaError } from "./registry.js"

const registry = createCoreRegistry()

/** 一条合法的 v1 tool_call，作为各测试的基底 */
function rawToolCall(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "0192b7a0-0000-7000-8000-000000000001",
    sessionId: "s1",
    seq: 3,
    at: 1_700_000_000_000,
    type: "core.tool_call",
    schemaVersion: 1,
    actor: "model",
    trust: "model",
    payload: { toolCallId: "tc1", name: "read_file", args: { path: "a.txt" } },
    ...overrides,
  }
}

describe("EventSchemaRegistry.read — 正常路径", () => {
  it("读出当前版本事件原样返回，payload 不动", () => {
    const e = registry.read<CoreEventOf<"core.tool_call">>(rawToolCall())
    expect(e.type).toBe("core.tool_call")
    expect(e.schemaVersion).toBe(1)
    expect(e.payload.name).toBe("read_file")
  })

  it("全部 core.* 都已登记且为 v1", () => {
    expect(CORE_SCHEMAS).toHaveLength(16)
    for (const s of CORE_SCHEMAS) {
      expect(registry.has(s.type)).toBe(true)
      expect(registry.currentVersion(s.type)).toBe(1)
    }
  })
})

describe("EventSchemaRegistry.read — fail-closed", () => {
  const expectCode = (raw: unknown, code: SchemaError["code"]) => {
    try {
      registry.read(raw)
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaError)
      expect((err as SchemaError).code).toBe(code)
      return
    }
    throw new Error(`应当抛出 ${code}`)
  }

  it("未登记的 type 拒绝", () => {
    expectCode(rawToolCall({ type: "ext.not_registered" }), "unknown_type")
  })

  it("版本比本地更新（旧代码读新日志）拒绝", () => {
    expectCode(rawToolCall({ schemaVersion: 2 }), "future_version")
  })

  it("壳字段畸形逐项拒绝", () => {
    expectCode(null, "malformed_base")
    expectCode("str", "malformed_base")
    expectCode(rawToolCall({ id: "" }), "malformed_base")
    expectCode(rawToolCall({ seq: 0 }), "malformed_base")
    expectCode(rawToolCall({ seq: 1.5 }), "malformed_base")
    expectCode(rawToolCall({ at: Number.NaN }), "malformed_base")
    expectCode(rawToolCall({ actor: "alien" }), "malformed_base")
    expectCode(rawToolCall({ trust: "whatever" }), "malformed_base")
    expectCode(rawToolCall({ schemaVersion: 0 }), "malformed_base")
    expectCode(rawToolCall({ provenance: { ref: "x" } }), "malformed_base")
    expectCode(rawToolCall({ replay: "sig" }), "malformed_base")
  })

  it("SchemaError 带 code 与上下文，便于排查", () => {
    try {
      registry.read(rawToolCall({ type: "ext.ghost" }))
    } catch (err) {
      const e = err as SchemaError
      expect(e.name).toBe("SchemaError")
      expect(e.message).toContain("[unknown_type]")
      expect(e.context).toEqual({ type: "ext.ghost" })
    }
  })
})

describe("schema 升级 v1 → v2（ext.* 示例）", () => {
  /**
   * 场景：宿主的 ext.deploy 事件 v1 只有 { env: string }，
   * v2 改为 { target: { env: string; region: string } }（改字段语义，必须升版本）。
   */
  const reg = createCoreRegistry([
    {
      type: "ext.deploy",
      version: 2,
      upcasters: {
        1: (p) => {
          const v1 = p as { env: string }
          return { target: { env: v1.env, region: "unknown" } }
        },
      },
    },
  ])

  it("旧日志里的 v1 读出来已是 v2 形状", () => {
    const e = reg.read<Event<"ext.deploy", { target: { env: string; region: string } }>>(
      rawToolCall({ type: "ext.deploy", schemaVersion: 1, payload: { env: "prod" } }),
    )
    expect(e.schemaVersion).toBe(2)
    expect(e.payload).toEqual({ target: { env: "prod", region: "unknown" } })
  })

  it("新写入的事件直接打 v2", () => {
    const e = createEvent(reg, {
      type: "ext.deploy",
      payload: { target: { env: "staging", region: "us" } },
      sessionId: "s1",
      seq: 1,
      actor: "host",
    })
    expect(e.schemaVersion).toBe(2)
    expect(reg.read(e)).toEqual(e)
  })

  it("三级链 v1→v2→v3 逐级执行", () => {
    const r3 = new EventSchemaRegistry([
      {
        type: "ext.counter",
        version: 3,
        upcasters: {
          1: (p) => ({ n: (p as { count: number }).count }),
          2: (p) => ({ n: (p as { n: number }).n * 10 }),
        },
      },
    ])
    expect(
      r3.read(rawToolCall({ type: "ext.counter", schemaVersion: 1, payload: { count: 4 } })).payload,
    ).toEqual({
      n: 40,
    })
    expect(
      r3.read(rawToolCall({ type: "ext.counter", schemaVersion: 2, payload: { n: 4 } })).payload,
    ).toEqual({
      n: 40,
    })
  })

  it("升级函数抛错 → upcaster_failed，不返回半个事件", () => {
    const r = new EventSchemaRegistry([
      {
        type: "ext.boom",
        version: 2,
        upcasters: {
          1: () => {
            throw new Error("bad data")
          },
        },
      },
    ])
    expect(() => r.read(rawToolCall({ type: "ext.boom", schemaVersion: 1 }))).toThrow(
      /upcaster_failed.*bad data/,
    )
  })
})

describe("EventSchemaRegistry.register — 登记时即校验", () => {
  it("升级链有缺口不允许登记", () => {
    expect(
      () => new EventSchemaRegistry([{ type: "ext.gap", version: 3, upcasters: { 1: (p) => p } }]),
    ).toThrow(/invalid_schema.*v2→v3/)
  })

  it("type 命名空间与版本号校验", () => {
    expect(() => new EventSchemaRegistry([{ type: "deploy", version: 1 }])).toThrow(/invalid_schema/)
    expect(() => new EventSchemaRegistry([{ type: "ext.Deploy", version: 1 }])).toThrow(/invalid_schema/)
    expect(() => new EventSchemaRegistry([{ type: "ext.x", version: 0 }])).toThrow(/invalid_schema/)
  })

  it("重复登记拒绝", () => {
    expect(() => createCoreRegistry([{ type: "core.tool_call", version: 1 }])).toThrow(/已登记/)
  })
})

describe("createEvent / createCoreEvent", () => {
  it("补齐 id、at、schemaVersion，trust 按 actor 默认", () => {
    const e = createCoreEvent(registry, {
      type: "core.tool_result",
      payload: { toolCallId: "tc1", name: "fetch", content: [{ type: "text", text: "ok" }], isError: false },
      sessionId: "s1",
      seq: 4,
      actor: "tool",
      at: 1_700_000_000_000,
    })
    expect(e.trust).toBe("untrusted")
    expect(e.schemaVersion).toBe(1)
    expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect("parentId" in e).toBe(false)
    expect(registry.read(e)).toEqual(e)
  })

  it("用户 → principal，系统/宿主 → system，模型 → model", () => {
    const mk = (actor: "user" | "system" | "host" | "model") =>
      createCoreEvent(registry, {
        type: "core.system_note",
        payload: { kind: "host", text: "" },
        sessionId: "s",
        seq: 1,
        actor,
      }).trust
    expect(mk("user")).toBe("principal")
    expect(mk("system")).toBe("system")
    expect(mk("host")).toBe("system")
    expect(mk("model")).toBe("model")
  })

  it("未登记的 type 在创建时就被拒绝，不会写进日志", () => {
    expect(() =>
      createEvent(registry, { type: "ext.nope", payload: {}, sessionId: "s", seq: 1, actor: "host" }),
    ).toThrow(/unknown_type/)
  })
})
