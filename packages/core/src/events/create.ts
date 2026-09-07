/**
 * 事件工厂：补齐 id / at / schemaVersion / trust，调用方只关心"谁、在哪个会话、第几条、说了什么"。
 * seq 由 EventLog 的 append 方决定（T4），这里要求显式传入，不替存储层做主。
 */
import { type Actor, DEFAULT_TRUST, type Event, type EventBase, type Provenance, type Trust } from "./base.js"
import type { CoreEventOf, CoreEventPayloads, CoreEventType } from "./core.js"
import { uuidv7 } from "./id.js"
import type { EventSchemaRegistry } from "./registry.js"

export interface CreateEventInput<T extends string, P> {
  type: T
  payload: P
  sessionId: string
  seq: number
  actor: Actor
  /** 缺省按 DEFAULT_TRUST[actor] */
  trust?: Trust
  parentId?: string
  provenance?: Provenance
  replay?: Record<string, unknown>
  /** 测试注入用；缺省 Date.now() */
  at?: number
  id?: string
}

/**
 * 通用工厂。schemaVersion 从注册表取当前版本，所以未登记的 type 会在这里就被拒绝，
 * 而不是写进日志后读不出来。
 */
export function createEvent<T extends string, P>(
  registry: EventSchemaRegistry,
  input: CreateEventInput<T, P>,
): Event<T, P> {
  const at = input.at ?? Date.now()
  const base: EventBase = {
    id: input.id ?? uuidv7(at),
    sessionId: input.sessionId,
    seq: input.seq,
    at,
    type: input.type,
    schemaVersion: registry.currentVersion(input.type),
    actor: input.actor,
    trust: input.trust ?? DEFAULT_TRUST[input.actor],
  }
  // 可选字段只在有值时写入，避免日志里出现一堆 undefined（exactOptionalPropertyTypes 也不允许）
  if (input.parentId !== undefined) base.parentId = input.parentId
  if (input.provenance !== undefined) base.provenance = input.provenance
  if (input.replay !== undefined) base.replay = input.replay
  return { ...base, type: input.type, payload: input.payload }
}

/** 内置事件的强类型版本：type 与 payload 联动校验。 */
export function createCoreEvent<T extends CoreEventType>(
  registry: EventSchemaRegistry,
  input: CreateEventInput<T, CoreEventPayloads[T]>,
): CoreEventOf<T> {
  return createEvent(registry, input) as CoreEventOf<T>
}
