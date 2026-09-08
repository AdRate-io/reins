/**
 * 内存实现直接跑一致性套件 —— 套件本身也借此得到验证（参考实现必须全绿）。
 * 这里故意从 ../testing 导入而不是相对到具体文件，模拟第三方 `@reins/core/testing` 的用法。
 */
import { describe, expect, it } from "vitest"
import { blobStoreConformance, eventLogConformance, memoryStoreConformance } from "../testing/index.js"
import { InMemoryBlobStore, InMemoryEventLog, InMemoryMemoryStore, memoryStore } from "./in-memory.js"

const harness = { describe, it }
eventLogConformance(harness, () => new InMemoryEventLog())
blobStoreConformance(harness, () => new InMemoryBlobStore())
memoryStoreConformance(harness, () => new InMemoryMemoryStore())

describe("memoryStore()", () => {
  it("一次给齐三个接口的内存实现，且每次调用都是新的一套", async () => {
    const a = memoryStore()
    const b = memoryStore()
    expect(a.log).toBeInstanceOf(InMemoryEventLog)
    expect(a.blobs).toBeInstanceOf(InMemoryBlobStore)
    expect(a.memory).toBeInstanceOf(InMemoryMemoryStore)
    await a.memory?.write("/memories/x", "1")
    expect(await b.memory?.read("/memories/x")).toBeNull()
  })
})
