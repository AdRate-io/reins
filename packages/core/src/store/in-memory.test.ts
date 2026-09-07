/**
 * 内存实现直接跑一致性套件 —— 套件本身也借此得到验证（参考实现必须全绿）。
 * 这里故意从 ../testing 导入而不是相对到具体文件，模拟第三方 `@reins/core/testing` 的用法。
 */
import { describe, it } from "vitest"
import { blobStoreConformance, eventLogConformance, memoryStoreConformance } from "../testing/index.js"
import { InMemoryBlobStore, InMemoryEventLog, InMemoryMemoryStore } from "./in-memory.js"

const harness = { describe, it }
eventLogConformance(harness, () => new InMemoryEventLog())
blobStoreConformance(harness, () => new InMemoryBlobStore())
memoryStoreConformance(harness, () => new InMemoryMemoryStore())
