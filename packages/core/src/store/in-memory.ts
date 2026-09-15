/**
 * 四个接口的内存实现：零依赖、进程内、无持久化。用途：
 * - 单测与示例
 * - 一致性套件的参考实现（其他后端的行为以此为准）
 * - 短生命周期的宿主（如一次性脚本）
 *
 * 读写都经过 structuredClone，调用方拿到的对象与内部存储互不影响。
 */
import type { Event } from "../events/base.js"
import { uuidv7 } from "../events/id.js"
import { StoreError } from "./errors.js"
import type { BlobMeta, BlobStore, EventLog, MemoryStore, ReadOptions, RunLease, Stores } from "./types.js"

export class InMemoryEventLog implements EventLog {
  private readonly sessions = new Map<string, Event[]>()

  async append(events: readonly Event[]): Promise<void> {
    if (events.length === 0) throw new StoreError("empty_batch", "append received an empty event array")
    const sessionId = (events[0] as Event).sessionId
    const existing = this.sessions.get(sessionId) ?? []
    let expected = existing.length + 1

    // 先整批校验，再一次性写入：保证"要么全写、要么不写"
    for (const e of events) {
      if (e.sessionId !== sessionId) {
        throw new StoreError("session_mismatch", "all events in one append must belong to the same session", {
          expected: sessionId,
          got: e.sessionId,
        })
      }
      if (e.seq !== expected) {
        throw new StoreError("seq_conflict", `session ${sessionId} expected seq=${expected}, got ${e.seq}`, {
          sessionId,
          expected,
          got: e.seq,
        })
      }
      expected++
    }

    const copy = existing.slice()
    for (const e of events) copy.push(structuredClone(e))
    this.sessions.set(sessionId, copy)
  }

  async *read(sessionId: string, opts: ReadOptions = {}): AsyncIterable<Event> {
    const events = this.sessions.get(sessionId) ?? []
    const from = opts.fromSeq ?? 1
    const to = opts.toSeq ?? Number.POSITIVE_INFINITY
    // 数组下标 = seq - 1，直接切片
    for (let i = Math.max(from, 1) - 1; i < events.length && i + 1 <= to; i++) {
      yield structuredClone(events[i] as Event)
    }
  }

  async tail(sessionId: string, n: number): Promise<Event[]> {
    if (!Number.isInteger(n) || n < 0)
      throw new StoreError("invalid_argument", `tail: n must be a non-negative integer, got ${n}`)
    const events = this.sessions.get(sessionId) ?? []
    return events.slice(Math.max(0, events.length - n)).map((e) => structuredClone(e))
  }

  async fork(fromSessionId: string, atSeq: number, toSessionId: string): Promise<void> {
    const source = this.sessions.get(fromSessionId) ?? []
    if (!Number.isInteger(atSeq) || atSeq < 1 || atSeq > source.length) {
      throw new StoreError(
        "out_of_range",
        `fork point ${atSeq} is outside session ${fromSessionId}'s range [1, ${source.length}]`,
        {
          fromSessionId,
          atSeq,
          lastSeq: source.length,
        },
      )
    }
    if ((this.sessions.get(toSessionId)?.length ?? 0) > 0) {
      throw new StoreError("target_not_empty", `target session ${toSessionId} already has events`, {
        toSessionId,
      })
    }
    this.sessions.set(
      toSessionId,
      source.slice(0, atSeq).map((e) => ({ ...structuredClone(e), sessionId: toSessionId })),
    )
  }
}

export class InMemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, { bytes: Uint8Array; meta: BlobMeta }>()

  async put(bytes: Uint8Array | string, meta: { mime: string; sessionId: string }): Promise<{ id: string }> {
    const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes.slice()
    const id = uuidv7()
    this.blobs.set(id, {
      bytes: data,
      meta: { mime: meta.mime, sessionId: meta.sessionId, size: data.byteLength, createdAt: Date.now() },
    })
    return { id }
  }

  async get(id: string): Promise<{ bytes: Uint8Array; meta: BlobMeta }> {
    const hit = this.blobs.get(id)
    if (!hit) throw new StoreError("not_found", `blob not found: ${id}`, { id })
    return { bytes: hit.bytes.slice(), meta: { ...hit.meta } }
  }

  async slice(id: string, range: { start: number; end: number }): Promise<Uint8Array> {
    const { bytes } = await this.get(id)
    return bytes.slice(Math.max(0, range.start), Math.min(bytes.byteLength, range.end))
  }
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly files = new Map<string, string>()

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort()
  }

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path)
  }
}

/**
 * RunLease 的内存参考实现（D4）。进程内的锁跨不了进程，所以它在生产里没有用处——`memoryStore()` 刻意不带它；
 * 价值在于：一致性套件的基准、server 租约登记表的单测（`now` 可注入，能不等真时间就让租约过期）。
 */
export class InMemoryRunLease implements RunLease {
  private readonly leases = new Map<string, { owner: string; expiresAt: number }>()
  private readonly now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now())
  }

  async acquire(sessionId: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = this.now()
    const held = this.leases.get(sessionId)
    if (held !== undefined && held.expiresAt >= now && held.owner !== owner) return false
    this.leases.set(sessionId, { owner, expiresAt: now + ttlMs })
    return true
  }

  async renew(sessionId: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = this.now()
    const held = this.leases.get(sessionId)
    if (held === undefined || held.owner !== owner || held.expiresAt < now) return false
    held.expiresAt = now + ttlMs
    return true
  }

  async release(sessionId: string, owner: string): Promise<void> {
    if (this.leases.get(sessionId)?.owner === owner) this.leases.delete(sessionId)
  }

  /** 测试观察用：当前持有者（不看是否过期） */
  holderOf(sessionId: string): string | undefined {
    return this.leases.get(sessionId)?.owner
  }
}

/** 一套全内存的存储，五分钟体验与测试用；进程结束即清空。不带 `runLease`：单进程用不上，装了只多一份心跳 */
export function memoryStore(): Stores {
  return { log: new InMemoryEventLog(), blobs: new InMemoryBlobStore(), memory: new InMemoryMemoryStore() }
}
