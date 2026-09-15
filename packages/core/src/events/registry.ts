/**
 * 事件 schema 注册表（P9：schema 有版本，读时升级，查不到即拒绝）。
 *
 * 职责：
 * 1. 登记每个 type 的当前版本与逐级升级函数 upcast(v → v+1)
 * 2. read(raw)：校验壳字段 → 查 type → 逐级升级到当前版本 → 返回类型化事件
 * 3. 任何一步查不到都抛 SchemaError（fail-closed），绝不静默返回半个事件
 *
 * 日志文件不做原地迁移：存的永远是写入时的版本，读时升级。
 */
import type { Actor, Event, EventBase, Trust } from "./base.js"
import type { CoreEventType } from "./core.js"

/** 把 payload 从版本 from 升到 from+1。只碰 payload，壳字段由注册表保证不变。 */
export type Upcaster = (payload: unknown) => unknown

export interface EventSchema {
  type: string
  /** 当前版本；新写入的事件一律打这个版本号 */
  version: number
  /**
   * 升级函数表，键为"起点版本"：upcasters[1] 把 v1 升到 v2。
   * version 为 n 时必须覆盖 1..n-1 全部键，缺一个即注册失败 —— 宁可启动时报错，不要读到一半才发现。
   */
  upcasters?: Readonly<Record<number, Upcaster>>
}

export type SchemaErrorCode =
  | "malformed_base" // 壳字段缺失或类型不对
  | "unknown_type" // 没登记的 type
  | "future_version" // 版本比注册表还新（旧代码读新日志）
  | "missing_upcaster" // 升级链断了
  | "upcaster_failed" // 升级函数自己抛了
  | "invalid_schema" // 登记时的定义不合法

export class SchemaError extends Error {
  constructor(
    readonly code: SchemaErrorCode,
    message: string,
    readonly context: { type?: string; version?: number } = {},
  ) {
    super(`[${code}] ${message}`)
    this.name = "SchemaError"
  }
}

const ACTORS: ReadonlySet<string> = new Set<Actor>(["user", "model", "tool", "system", "host"])
const TRUSTS: ReadonlySet<string> = new Set<Trust>(["principal", "system", "model", "untrusted"])

export class EventSchemaRegistry {
  private readonly schemas = new Map<string, EventSchema>()

  constructor(schemas: Iterable<EventSchema> = []) {
    for (const s of schemas) this.register(s)
  }

  /** 登记一个 type。重复登记同一 type 视为错误，避免两处定义互相覆盖。 */
  register(schema: EventSchema): this {
    if (!schema.type || !/^(core|ext)\.[a-z][a-z0-9_]*$/.test(schema.type)) {
      throw new SchemaError(
        "invalid_schema",
        `type must look like "core.xxx" or "ext.xxx", got ${schema.type}`,
        {
          type: schema.type,
        },
      )
    }
    if (!Number.isInteger(schema.version) || schema.version < 1) {
      throw new SchemaError("invalid_schema", `version must be an integer >= 1, got ${schema.version}`, {
        type: schema.type,
        version: schema.version,
      })
    }
    if (this.schemas.has(schema.type)) {
      throw new SchemaError("invalid_schema", `type already registered: ${schema.type}`, {
        type: schema.type,
      })
    }
    for (let v = 1; v < schema.version; v++) {
      if (typeof schema.upcasters?.[v] !== "function") {
        throw new SchemaError(
          "invalid_schema",
          `${schema.type} is at version ${schema.version} but has no v${v} -> v${v + 1} upgrade function`,
          { type: schema.type, version: v },
        )
      }
    }
    this.schemas.set(schema.type, schema)
    return this
  }

  has(type: string): boolean {
    return this.schemas.has(type)
  }

  /** 该 type 当前应写入的版本号；未登记则抛 unknown_type。 */
  currentVersion(type: string): number {
    const s = this.schemas.get(type)
    if (!s) throw new SchemaError("unknown_type", `unregistered event type: ${type}`, { type })
    return s.version
  }

  /**
   * 从存储读出的原始对象 → 当前版本的事件。
   * 泛型只是给调用方的类型提示（如 read<CoreEvent>），运行时校验的是壳与版本，不校验 payload 形状 ——
   * payload 的正确性由写入方与升级函数负责。
   */
  read<E extends Event = Event>(raw: unknown): E {
    const base = assertBase(raw)
    const schema = this.schemas.get(base.type)
    if (!schema) {
      throw new SchemaError("unknown_type", `unregistered event type: ${base.type}`, { type: base.type })
    }
    if (base.schemaVersion > schema.version) {
      throw new SchemaError(
        "future_version",
        `${base.type} v${base.schemaVersion} is newer than the locally known v${schema.version}; upgrade the code`,
        { type: base.type, version: base.schemaVersion },
      )
    }

    let payload = (raw as { payload?: unknown }).payload
    for (let v = base.schemaVersion; v < schema.version; v++) {
      const up = schema.upcasters?.[v]
      if (!up) {
        // register() 已保证不会走到这里，留作防御
        throw new SchemaError("missing_upcaster", `${base.type} has no v${v} -> v${v + 1} upgrade function`, {
          type: base.type,
          version: v,
        })
      }
      try {
        payload = up(payload)
      } catch (cause) {
        throw new SchemaError(
          "upcaster_failed",
          `${base.type} v${v} -> v${v + 1} upgrade failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { type: base.type, version: v },
        )
      }
    }

    return { ...base, schemaVersion: schema.version, payload } as E
  }
}

/** 校验壳字段。只看公共字段，payload 不管。 */
function assertBase(raw: unknown): EventBase {
  if (typeof raw !== "object" || raw === null) {
    throw new SchemaError("malformed_base", "event must be an object")
  }
  const r = raw as Record<string, unknown>
  const fail = (field: string, expect: string): never => {
    throw new SchemaError(
      "malformed_base",
      `field ${field} must be ${expect}`,
      typeof r.type === "string" ? { type: r.type } : {},
    )
  }
  if (typeof r.id !== "string" || r.id === "") fail("id", "a non-empty string")
  if (typeof r.sessionId !== "string" || r.sessionId === "") fail("sessionId", "a non-empty string")
  if (!Number.isInteger(r.seq) || (r.seq as number) < 1) fail("seq", "an integer >= 1")
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) fail("at", "a finite number")
  if (typeof r.type !== "string" || r.type === "") fail("type", "a non-empty string")
  if (!Number.isInteger(r.schemaVersion) || (r.schemaVersion as number) < 1)
    fail("schemaVersion", "an integer >= 1")
  if (typeof r.actor !== "string" || !ACTORS.has(r.actor)) fail("actor", "user|model|tool|system|host")
  if (typeof r.trust !== "string" || !TRUSTS.has(r.trust)) fail("trust", "principal|system|model|untrusted")
  if (r.parentId !== undefined && typeof r.parentId !== "string") fail("parentId", "a string or undefined")
  if (r.provenance !== undefined) {
    const p = r.provenance as Record<string, unknown> | null
    if (typeof p !== "object" || p === null || typeof p.source !== "string")
      fail("provenance", "{ source: string }")
  }
  if (r.replay !== undefined && (typeof r.replay !== "object" || r.replay === null))
    fail("replay", "an object or undefined")
  return r as unknown as EventBase
}

/** 全部内置事件当前都是 v1。升版本时在此加 upcasters，并在 core.ts 改载荷类型。 */
export const CORE_SCHEMAS: readonly EventSchema[] = (
  [
    "core.user_message",
    "core.model_text",
    "core.model_thinking",
    "core.tool_call",
    "core.tool_result",
    "core.system_note",
    "core.approval_request",
    "core.approval_decision",
    "core.compaction",
    "core.handoff",
    "core.memory_op",
    "core.budget_usage",
    "core.run_paused",
    "core.run_resumed",
    "core.tools_bound",
    "core.error",
  ] satisfies CoreEventType[]
).map((type) => ({ type, version: 1 }))

/** 预装了全部 core.* 的注册表。宿主要加 ext.* 时 new 一个并传入 [...CORE_SCHEMAS, ...自己的]。 */
export function createCoreRegistry(extra: Iterable<EventSchema> = []): EventSchemaRegistry {
  return new EventSchemaRegistry([...CORE_SCHEMAS, ...extra])
}
