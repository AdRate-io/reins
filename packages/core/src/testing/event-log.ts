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
  t.describe("EventLog 一致性", () => {
    t.it("空会话读出空流，tail 为空", async () => {
      const log = await factory()
      assertEqual(await collect(log.read("none")), [], "空会话 read")
      assertEqual(await log.tail("none", 5), [], "空会话 tail")
    })

    t.it("append 后按 seq 升序读回，内容逐字段一致", async () => {
      const log = await factory()
      const events = makeEvents("s1", 3)
      await log.append(events)
      assertEqual(await collect(log.read("s1")), events, "read 全量")
    })

    t.it("多批 append 连续累积", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 2))
      await log.append(makeEvents("s1", 2, 3))
      assertEqual(seqs(await collect(log.read("s1"))), [1, 2, 3, 4], "两批合并后 seq")
    })

    t.it("read 支持 fromSeq / toSeq 闭区间", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 5))
      assertEqual(seqs(await collect(log.read("s1", { fromSeq: 2, toSeq: 4 }))), [2, 3, 4], "闭区间")
      assertEqual(seqs(await collect(log.read("s1", { fromSeq: 4 }))), [4, 5], "只给 from")
      assertEqual(seqs(await collect(log.read("s1", { toSeq: 2 }))), [1, 2], "只给 to")
      assertEqual(seqs(await collect(log.read("s1", { fromSeq: 9 }))), [], "from 越界得空")
    })

    t.it("tail 返回最后 n 条，升序；n 大于总数返回全部；n=0 返回空", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 5))
      assertEqual(seqs(await log.tail("s1", 2)), [4, 5], "tail 2")
      assertEqual(seqs(await log.tail("s1", 10)), [1, 2, 3, 4, 5], "tail 超量")
      assertEqual(seqs(await log.tail("s1", 0)), [], "tail 0")
    })

    t.it("会话之间隔离", async () => {
      const log = await factory()
      await log.append(makeEvents("a", 2))
      await log.append(makeEvents("b", 3))
      assertEqual(seqs(await collect(log.read("a"))), [1, 2], "会话 a")
      assertEqual(seqs(await collect(log.read("b"))), [1, 2, 3], "会话 b")
    })

    t.it("首条 seq 必须为 1", async () => {
      const log = await factory()
      await assertThrowsCode(() => log.append(makeEvents("s1", 1, 2)), "seq_conflict", "首条 seq=2 应拒绝")
      assertEqual(await collect(log.read("s1")), [], "拒绝后不应留下任何事件")
    })

    t.it("seq 不连续 → seq_conflict，且整批不写入（原子）", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 2))
      const bad = [...makeEvents("s1", 1, 3), ...makeEvents("s1", 1, 5)] // 3 然后 5，跳过 4
      await assertThrowsCode(() => log.append(bad), "seq_conflict", "跳号应拒绝")
      assertEqual(seqs(await collect(log.read("s1"))), [1, 2], "整批回滚，seq=3 也不能写进去")
    })

    t.it("重复 seq（并发写入者）→ seq_conflict", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 2))
      await assertThrowsCode(() => log.append(makeEvents("s1", 1, 2)), "seq_conflict", "重复 seq=2 应拒绝")
    })

    t.it("一批混多个会话 → session_mismatch", async () => {
      const log = await factory()
      await assertThrowsCode(
        () => log.append([...makeEvents("a", 1), ...makeEvents("b", 1, 2)]),
        "session_mismatch",
        "混会话应拒绝",
      )
    })

    t.it("空数组 → empty_batch", async () => {
      const log = await factory()
      await assertThrowsCode(() => log.append([]), "empty_batch", "空批应拒绝")
    })

    t.it("读出的对象是副本：改它不影响日志", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 1))
      const [first] = await collect(log.read("s1"))
      ;(first as { payload: { content: unknown[] } }).payload.content.length = 0
      const [again] = await collect(log.read("s1"))
      assertEqual(
        (again as Event<string, { content: unknown[] }>).payload.content.length,
        1,
        "内部数据被外部篡改",
      )
    })

    t.it("fork：复制 [1, atSeq]，保留 id 与 seq，只换 sessionId", async () => {
      const log = await factory()
      const src = makeEvents("s1", 4)
      await log.append(src)
      await log.fork("s1", 2, "s2")
      const forked = await collect(log.read("s2"))
      assertEqual(
        forked,
        src.slice(0, 2).map((e) => ({ ...e, sessionId: "s2" })),
        "分叉内容",
      )
    })

    t.it("fork 后两条会话独立演进", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 2))
      await log.fork("s1", 2, "s2")
      await log.append(makeEvents("s1", 1, 3))
      await log.append(makeEvents("s2", 2, 3))
      assertEqual(seqs(await collect(log.read("s1"))), [1, 2, 3], "源会话")
      assertEqual(seqs(await collect(log.read("s2"))), [1, 2, 3, 4], "分叉会话")
      const s2 = await collect(log.read("s2"))
      assert(
        s2.every((e) => e.sessionId === "s2"),
        "分叉会话里所有事件 sessionId 应为 s2",
      )
    })

    t.it("fork 目标已有事件 → target_not_empty", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 2))
      await log.append(makeEvents("s2", 1))
      await assertThrowsCode(() => log.fork("s1", 1, "s2"), "target_not_empty", "目标非空应拒绝")
    })

    t.it("fork 的 atSeq 越界或源会话不存在 → out_of_range", async () => {
      const log = await factory()
      await log.append(makeEvents("s1", 2))
      await assertThrowsCode(() => log.fork("s1", 3, "s2"), "out_of_range", "atSeq 超出末尾")
      await assertThrowsCode(() => log.fork("s1", 0, "s2"), "out_of_range", "atSeq=0")
      await assertThrowsCode(() => log.fork("ghost", 1, "s2"), "out_of_range", "源会话不存在")
    })
  })
}
