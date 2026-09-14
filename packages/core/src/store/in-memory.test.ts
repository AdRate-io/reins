/**
 * 内存实现直接跑一致性套件 —— 套件本身也借此得到验证（参考实现必须全绿）。
 * 这里故意从 ../testing 导入而不是相对到具体文件，模拟第三方 `@reinsjs/core/testing` 的用法。
 */
import { describe, expect, it } from "vitest"
import {
  blobStoreConformance,
  eventLogConformance,
  memoryStoreConformance,
  runLeaseConformance,
} from "../testing/index.js"
import {
  InMemoryBlobStore,
  InMemoryEventLog,
  InMemoryMemoryStore,
  InMemoryRunLease,
  memoryStore,
} from "./in-memory.js"

const harness = { describe, it }
eventLogConformance(harness, () => new InMemoryEventLog())
blobStoreConformance(harness, () => new InMemoryBlobStore())
memoryStoreConformance(harness, () => new InMemoryMemoryStore())
runLeaseConformance(harness, () => new InMemoryRunLease())

describe("InMemoryRunLease 的可注入时钟", () => {
  it("拨快时钟即过期：别人接手、原持有者 renew 为 false，不用真等", async () => {
    let now = 1_000
    const lease = new InMemoryRunLease({ now: () => now })
    expect(await lease.acquire("s1", "a", 30_000)).toBe(true)
    now += 29_999
    expect(await lease.acquire("s1", "b", 30_000)).toBe(false) // 还差 1 ms
    now += 2
    expect(await lease.acquire("s1", "b", 30_000)).toBe(true)
    expect(lease.holderOf("s1")).toBe("b")
    expect(await lease.renew("s1", "a", 30_000)).toBe(false)
  })
})

describe("memoryStore()", () => {
  it("一次给齐三个接口的内存实现，且每次调用都是新的一套；刻意不带 runLease", async () => {
    const a = memoryStore()
    const b = memoryStore()
    expect(a.log).toBeInstanceOf(InMemoryEventLog)
    expect(a.blobs).toBeInstanceOf(InMemoryBlobStore)
    expect(a.memory).toBeInstanceOf(InMemoryMemoryStore)
    expect(a.runLease).toBeUndefined()
    await a.memory?.write("/memories/x", "1")
    expect(await b.memory?.read("/memories/x")).toBeNull()
  })
})
