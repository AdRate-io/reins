/**
 * EventLog 一致性套件。任何后端（内存、SQLite、Durable Objects…）跑过本套件即视为合规。
 *
 * 用法：
 *   eventLogConformance({ describe, it }, () => new MyEventLog())
 * factory 每个用例调用一次，须返回一个空日志（或带唯一前缀的隔离命名空间）。
 */
import type { Event } from "../events/base.js"
import { createCoreEvent } from "../events/create.js"
import { createCoreRegistry } from "../events/registry.js"
import type { EventLog } from "../store/types.js"
import { assert, assertEqual, assertThrowsCode, collect, type TestHarness } from "./harness.js"

const registry = createCoreRegistry()

/** 造 n 条连续的 user_message，seq 从 startSeq 起 */
export function makeEvents(sessionId: string, n: number, startSeq = 1): Event[] {
  return Array.from({ length: n }, (_, i) =>
    createCoreEvent(registry, {
      type: "core.user_message",
      payload: { content: [{ type: "text", text: `msg ${startSeq + i}` }] },
      sessionId,
      seq: startSeq + i,
      actor: "user",
      at: 1_700_000_000_000 + i,
    }),
  )
}

const seqs = (events: Event[]) => events.map((e) => e.seq)

export function eventLogConformance(t: TestHarness, factory: () => EventLog | Promise<EventLog>): void {
  t.describe("EventLog conformance", () => {
    t.it("an empty session reads back an empty stream and an empty tail", async () => {
      const log = await factory()
      assertEqual(await collect(log.read("none")), [], "read on an empty session")
      assertEqual(await log.tail("none", 5), [], "tail on an empty session")
    })

    t.it("after append, events read back in ascending seq order, field for field", async () => {
      const log = await factory()
      const events = makeEvents("s1", 3)
      await log.append(events)
      assertEqual(await collect(log.read("s1")), events, "full read")
    })

    t.it("successive append batches accumulate", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 2))
      await log.append(makeEvents("s1", 2, 3))
      assertEqual(seqs(await collect(log.read("s1"))), [1, 2, 3, 4], "seq after merging two batches")
    })

    t.it("read supports the closed range fromSeq / toSeq", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 5))
      assertEqual(seqs(await collect(log.read("s1", { fromSeq: 2, toSeq: 4 }))), [2, 3, 4], "closed range")
      assertEqual(seqs(await collect(log.read("s1", { fromSeq: 4 }))), [4, 5], "from only")
      assertEqual(seqs(await collect(log.read("s1", { toSeq: 2 }))), [1, 2], "to only")
      assertEqual(
        seqs(await collect(log.read("s1", { fromSeq: 9 }))),
        [],
        "a from beyond the end gives nothing",
      )
    })

    t.it(
      "tail returns the last n events in ascending order; an n above the total returns everything; n=0 returns nothing",
      async () => {
        const log = await factory()
        await log.append(makeEvents("s1", 5))
        assertEqual(seqs(await log.tail("s1", 2)), [4, 5], "tail 2")
        assertEqual(seqs(await log.tail("s1", 10)), [1, 2, 3, 4, 5], "tail beyond the total")
        assertEqual(seqs(await log.tail("s1", 0)), [], "tail 0")
      },
    )

    t.it("sessions are isolated from each other", async () => {
      const log = await factory()
      await log.append(makeEvents("a", 2))
      await log.append(makeEvents("b", 3))
      assertEqual(seqs(await collect(log.read("a"))), [1, 2], "session a")
      assertEqual(seqs(await collect(log.read("b"))), [1, 2, 3], "session b")
    })

    t.it("the first event must have seq 1", async () => {
      const log = await factory()
      await assertThrowsCode(
        () => log.append(makeEvents("s1", 1, 2)),
        "seq_conflict",
        "a first event with seq=2 must be rejected",
      )
      assertEqual(await collect(log.read("s1")), [], "nothing must be left behind after a rejection")
    })

    t.it("a gap in seq -> seq_conflict, and the whole batch is not written (atomic)", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 2))
      const bad = [...makeEvents("s1", 1, 3), ...makeEvents("s1", 1, 5)] // 3 然后 5，跳过 4
      await assertThrowsCode(() => log.append(bad), "seq_conflict", "a gap must be rejected")
      assertEqual(
        seqs(await collect(log.read("s1"))),
        [1, 2],
        "the whole batch rolls back, so seq=3 must not land either",
      )
    })

    t.it("a duplicate seq (a concurrent writer) -> seq_conflict", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 2))
      await assertThrowsCode(
        () => log.append(makeEvents("s1", 1, 2)),
        "seq_conflict",
        "a duplicate seq=2 must be rejected",
      )
    })

    t.it("mixing sessions in one batch -> session_mismatch", async () => {
      const log = await factory()
      await assertThrowsCode(
        () => log.append([...makeEvents("a", 1), ...makeEvents("b", 1, 2)]),
        "session_mismatch",
        "a mixed-session batch must be rejected",
      )
    })

    t.it("an empty array -> empty_batch", async () => {
      const log = await factory()
      await assertThrowsCode(() => log.append([]), "empty_batch", "an empty batch must be rejected")
    })

    t.it("events read back are copies: mutating them does not affect the log", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 1))
      const [first] = await collect(log.read("s1"))
      ;(first as { payload: { content: unknown[] } }).payload.content.length = 0
      const [again] = await collect(log.read("s1"))
      assertEqual(
        (again as Event<string, { content: unknown[] }>).payload.content.length,
        1,
        "internal data was tampered with from outside",
      )
    })

    t.it("fork: copies [1, atSeq], keeping id and seq, changing only sessionId", async () => {
      const log = await factory()
      const src = makeEvents("s1", 4)
      await log.append(src)
      await log.fork("s1", 2, "s2")
      const forked = await collect(log.read("s2"))
      assertEqual(
        forked,
        src.slice(0, 2).map((e) => ({ ...e, sessionId: "s2" })),
        "forked content",
      )
    })

    t.it("after a fork the two sessions evolve independently", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 2))
      await log.fork("s1", 2, "s2")
      await log.append(makeEvents("s1", 1, 3))
      await log.append(makeEvents("s2", 2, 3))
      assertEqual(seqs(await collect(log.read("s1"))), [1, 2, 3], "source session")
      assertEqual(seqs(await collect(log.read("s2"))), [1, 2, 3, 4], "forked session")
      const s2 = await collect(log.read("s2"))
      assert(
        s2.every((e) => e.sessionId === "s2"),
        "every event in the forked session must carry sessionId s2",
      )
    })

    t.it("a fork target that already has events -> target_not_empty", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 2))
      await log.append(makeEvents("s2", 1))
      await assertThrowsCode(
        () => log.fork("s1", 1, "s2"),
        "target_not_empty",
        "a non-empty target must be rejected",
      )
    })

    t.it("an out-of-range atSeq or an unknown source session -> out_of_range", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 2))
      await assertThrowsCode(() => log.fork("s1", 3, "s2"), "out_of_range", "atSeq beyond the end")
      await assertThrowsCode(() => log.fork("s1", 0, "s2"), "out_of_range", "atSeq=0")
      await assertThrowsCode(() => log.fork("ghost", 1, "s2"), "out_of_range", "unknown source session")
    })
  })
}
