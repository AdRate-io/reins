/**
 * @reinsjs/core/testing —— 存储后端一致性套件（T5）与脚本化降级层（T9）。
 *
 * 第三方后端只需：
 *   import { describe, it } from "vitest"
 *   import { eventLogConformance } from "@reinsjs/core/testing"
 *   eventLogConformance({ describe, it }, () => new MyEventLog())
 */
export * from "./blob-store.js"
export * from "./event-log.js"
export * from "./harness.js"
export * from "./memory-store.js"
export * from "./run-lease.js"
export * from "./scripted-lowering.js"
