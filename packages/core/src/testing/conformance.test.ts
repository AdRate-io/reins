/**
 * 一致性套件自检：套件全绿是第三方后端"自证合规"的依据，所以要证明它真能拦住典型的错误实现。
 * 每个坏后端只坏一处，断言套件里对应的用例失败（其余用例不关心）。
 */
import { describe, expect, it } from "vitest"
import type { Event } from "../events/base.js"
import { InMemoryEventLog } from "../store/in-memory.js"
import type { EventLog } from "../store/types.js"
import { eventLogConformance } from "./event-log.js"
import type { TestHarness } from "./harness.js"

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

describe("conformance suites catch broken backends", () => {
  it("EventLog: a backend that drops optional shell fields fails the round-trip and fork cases", async () => {
    const failed = await failingCases((t) => eventLogConformance(t, () => new LossyEventLog()))
    expect(failed).toEqual([
      "every shell field and the payload round-trip verbatim: parentId, provenance, nested replay, non-ASCII and large payloads, a non-current schemaVersion and ext.* types",
      "fork keeps every shell field of the copied events",
    ])
  })

  it("the reference in-memory backends pass every case", async () => {
    expect(await failingCases((t) => eventLogConformance(t, () => new InMemoryEventLog()))).toEqual([])
  })
})
