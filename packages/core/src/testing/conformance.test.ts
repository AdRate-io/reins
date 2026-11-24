/**
 * 一致性套件自检：套件全绿是第三方后端"自证合规"的依据，所以要证明它真能拦住典型的错误实现。
 * 每个坏后端只坏一处，断言套件里对应的用例失败（其余用例不关心）。
 */
import { describe, expect, it } from "vitest"
import type { Event } from "../events/base.js"
import { StoreError } from "../store/errors.js"
import { InMemoryBlobStore, InMemoryEventLog, InMemoryRunLease } from "../store/in-memory.js"
import type { BlobMeta, BlobStore, EventLog, ReadOptions } from "../store/types.js"
import { blobStoreConformance } from "./blob-store.js"
import { eventLogConformance } from "./event-log.js"
import type { TestHarness } from "./harness.js"
import { runLeaseConformance } from "./run-lease.js"

/** 让出一次事件循环：并发写入者在"查"与"写"之间被交错 */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** 把套件里的用例收集成 名字 → 函数，不经测试框架直接跑 */
function casesOf(register: (t: TestHarness) => void): Map<string, () => Promise<void> | void> {
  const cases = new Map<string, () => Promise<void> | void>()
  register({ describe: (_name, fn) => fn(), it: (name, fn) => void cases.set(name, fn) })
  return cases
}

async function failingCases(register: (t: TestHarness) => void): Promise<string[]> {
  const failed: string[] = []
  for (const [name, fn] of casesOf(register)) {
    try {
      await fn()
    } catch {
      failed.push(name)
    }
  }
  return failed
}

/** 只存部分列的后端：append 前剥掉可选壳字段（按列拆存、漏了 replay / provenance / parentId 的样子） */
class LossyEventLog implements EventLog {
  private readonly inner = new InMemoryEventLog()
  append(events: readonly Event[]) {
    return this.inner.append(
      events.map(({ replay: _r, provenance: _p, parentId: _i, ...rest }) => rest as Event),
    )
  }
  read(...args: Parameters<EventLog["read"]>) {
    return this.inner.read(...args)
  }
  tail(...args: Parameters<EventLog["tail"]>) {
    return this.inner.tail(...args)
  }
  fork(...args: Parameters<EventLog["fork"]>) {
    return this.inner.fork(...args)
  }
}

/** 先读末尾、让出、再按读到的末尾校验并写入，没有 (session, seq) 唯一约束 */
class RacyEventLog implements EventLog {
  private readonly sessions = new Map<string, Event[]>()
  async append(events: readonly Event[]) {
    const first = events[0]
    if (!first) throw new StoreError("empty_batch", "empty batch")
    const last = this.sessions.get(first.sessionId)?.length ?? 0
    await tick()
    if (first.seq !== last + 1) throw new StoreError("seq_conflict", "seq conflict")
    this.sessions.set(first.sessionId, [
      ...(this.sessions.get(first.sessionId) ?? []),
      ...structuredClone([...events]),
    ])
  }
  async *read(sessionId: string, opts: ReadOptions = {}) {
    for (const e of this.sessions.get(sessionId) ?? [])
      if (e.seq >= (opts.fromSeq ?? 1) && e.seq <= (opts.toSeq ?? Number.POSITIVE_INFINITY))
        yield structuredClone(e)
  }
  async tail(sessionId: string, n: number) {
    return structuredClone((this.sessions.get(sessionId) ?? []).slice(-n || Number.POSITIVE_INFINITY))
  }
  async fork() {}
}

/** 读改写：查持有者、让出、再写 */
class RacyRunLease extends InMemoryRunLease {
  private readonly held = new Map<string, string>()
  override async acquire(sessionId: string, owner: string) {
    const holder = this.held.get(sessionId)
    await tick()
    if (holder !== undefined && holder !== owner) return false
    this.held.set(sessionId, owner)
    return true
  }
  override async renew(sessionId: string, owner: string) {
    return this.held.get(sessionId) === owner
  }
}

/** put 存的是调用方缓冲区的引用，不是副本 */
class AliasingBlobStore implements BlobStore {
  private readonly inner = new InMemoryBlobStore()
  private readonly aliased = new Map<string, Uint8Array>()
  async put(bytes: Uint8Array | string, meta: { mime: string; sessionId: string }) {
    const { id } = await this.inner.put(bytes, meta)
    if (typeof bytes !== "string") this.aliased.set(id, bytes)
    return { id }
  }
  async get(id: string): Promise<{ bytes: Uint8Array; meta: BlobMeta }> {
    const got = await this.inner.get(id)
    const alias = this.aliased.get(id)
    return alias ? { bytes: alias.slice(), meta: got.meta } : got
  }
}

describe("conformance suites catch broken backends", () => {
  it("EventLog: a check-then-write backend without a unique (session, seq) fails the concurrent append case", async () => {
    const failed = await failingCases((t) => eventLogConformance(t, () => new RacyEventLog()))
    expect(failed).toContain(
      "concurrent appends of the same seq: exactly one lands, the other gets seq_conflict",
    )
  })

  it("RunLease: a read-modify-write acquire fails the concurrent acquire case", async () => {
    const failed = await failingCases((t) => runLeaseConformance(t, () => new RacyRunLease()))
    expect(failed).toContain("concurrent acquires by different owners on a free session: exactly one wins")
  })

  it("BlobStore: a backend that keeps the caller's buffer fails the copy-on-put case", async () => {
    const failed = await failingCases((t) => blobStoreConformance(t, () => new AliasingBlobStore()))
    expect(failed).toEqual([
      "put copies the bytes: mutating the caller's buffer afterwards does not affect the store",
    ])
  })

  it("EventLog: a backend that drops optional shell fields fails the round-trip and fork cases", async () => {
    const failed = await failingCases((t) => eventLogConformance(t, () => new LossyEventLog()))
    expect(failed).toEqual([
      "every shell field and the payload round-trip verbatim: parentId, provenance, nested replay, non-ASCII and large payloads, a non-current schemaVersion and ext.* types",
      "fork keeps every shell field of the copied events",
    ])
  })

  it("the reference in-memory backends pass every case", async () => {
    expect(await failingCases((t) => eventLogConformance(t, () => new InMemoryEventLog()))).toEqual([])
    expect(await failingCases((t) => runLeaseConformance(t, () => new InMemoryRunLease()))).toEqual([])
    expect(await failingCases((t) => blobStoreConformance(t, () => new InMemoryBlobStore()))).toEqual([])
  })
})
