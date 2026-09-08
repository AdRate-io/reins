/**
 * 从 EventLog 读事件的唯一正确姿势：读出来的每一条都先过注册表（P9：读时 upcast，查不到升级函数即拒绝）。
 *
 * 存储层只负责原样存取，不认识 schema；日志里可能躺着旧版本事件（升级代码后），也可能有宿主的 ext.* 事件。
 * 循环、server 补发、回放都经这里读，模型与前端看到的永远是当前版本的形状；
 * 未登记的类型或未来版本会在这里抛 SchemaError，而不是被静默透传或读到一半才发现。
 */
import type { Event } from "../events/base.js"
import type { EventSchemaRegistry } from "../events/registry.js"
import type { EventLog, ReadOptions } from "./types.js"

export interface ReadTimelineOptions extends ReadOptions {
  /** 有 ext.* 事件时传宿主自己的注册表；缺省内置 core 注册表由调用方决定，这里不隐式创建 */
  registry: EventSchemaRegistry
}

/** 流式：按 seq 升序逐条升级后产出 */
export async function* readEvents(
  log: EventLog,
  sessionId: string,
  opts: ReadTimelineOptions,
): AsyncGenerator<Event> {
  const { registry, ...range } = opts
  for await (const raw of log.read(sessionId, range)) yield registry.read(raw)
}

/** 整段：循环每轮都要完整时间线，这个最常用 */
export async function readTimeline(
  log: EventLog,
  sessionId: string,
  opts: ReadTimelineOptions,
): Promise<Event[]> {
  const out: Event[] = []
  for await (const e of readEvents(log, sessionId, opts)) out.push(e)
  return out
}
