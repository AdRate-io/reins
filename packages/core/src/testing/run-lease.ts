/**
 * RunLease 一致性套件（D4）。过期一项用真时间等（ttl 1 ms、等 30 ms）：套件不知道后端的时钟怎么注入，
 * 而 Postgres 实现刻意用数据库时间，测试时钟只能是真时钟。
 */
import type { RunLease } from "../store/types.js"
import { assert, assertEqual, type TestHarness } from "./harness.js"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function runLeaseConformance(t: TestHarness, factory: () => RunLease | Promise<RunLease>): void {
  t.describe("RunLease conformance", () => {
    t.it(
      "acquire succeeds on a free session, fails while someone else holds an unexpired lease, and sessions do not affect each other",
      async () => {
        const lease = await factory()
        assertEqual(await lease.acquire("s1", "a", 60_000), true, "first acquire")
        assertEqual(await lease.acquire("s1", "b", 60_000), false, "someone else is holding it")
        assertEqual(await lease.acquire("s2", "b", 60_000), true, "another session is unaffected")
      },
    )

    // 真并发：读改写（先查持有者、再写）的实现会让几个 owner 都拿到 true
    t.it("concurrent acquires by different owners on a free session: exactly one wins", async () => {
      const lease = await factory()
      const owners = ["a", "b", "c", "d", "e", "f", "g", "h"]
      const won = await Promise.all(owners.map((o) => lease.acquire("s1", o, 60_000)))
      assertEqual(won.filter(Boolean).length, 1, "exactly one concurrent acquire must win")
      const winner = owners[won.indexOf(true)] as string
      assertEqual(await lease.renew("s1", winner, 60_000), true, "the winner holds the lease")
      for (const o of owners) {
        if (o !== winner) assertEqual(await lease.renew("s1", o, 60_000), false, `loser ${o} cannot renew`)
      }
    })

    t.it(
      "a repeated acquire by the same owner is idempotent (it renews) and does not change who holds the lease",
      async () => {
        const lease = await factory()
        assertEqual(await lease.acquire("s1", "a", 60_000), true, "first")
        assertEqual(await lease.acquire("s1", "a", 60_000), true, "the same owner acquires again")
        assertEqual(await lease.acquire("s1", "b", 60_000), false, "someone else still cannot acquire")
        assertEqual(await lease.renew("s1", "a", 60_000), true, "the owner can still renew")
      },
    )

    t.it("renew: the holder succeeds; a non-holder fails; a never-acquired session fails", async () => {
      const lease = await factory()
      await lease.acquire("s1", "a", 60_000)
      assertEqual(await lease.renew("s1", "a", 60_000), true, "the holder renews")
      assertEqual(await lease.renew("s1", "b", 60_000), false, "a non-holder")
      assertEqual(await lease.renew("nope", "a", 60_000), false, "an unknown session")
    })

    t.it(
      "release: after the holder releases, someone else can acquire; a release by a non-holder does nothing; releasing an unknown session does not throw",
      async () => {
        const lease = await factory()
        await lease.acquire("s1", "a", 60_000)
        await lease.release("s1", "b") // 不是自己的，不该动
        assertEqual(
          await lease.acquire("s1", "b", 60_000),
          false,
          "a still holds the lease after a non-holder releases",
        )
        await lease.release("s1", "a")
        assertEqual(
          await lease.acquire("s1", "b", 60_000),
          true,
          "after the holder releases, the lease can be acquired again",
        )
        await lease.release("nope", "a") // 幂等
      },
    )

    t.it(
      "expiry: once it lapses, someone else can take over, the old holder's renew is false, and the new holder renews normally",
      async () => {
        const lease = await factory()
        assertEqual(await lease.acquire("s1", "a", 1), true, "short lease")
        await sleep(30)
        assertEqual(await lease.acquire("s1", "b", 60_000), true, "taking over after expiry")
        assertEqual(await lease.renew("s1", "a", 60_000), false, "the party that lost the lease cannot renew")
        assertEqual(await lease.renew("s1", "b", 60_000), true, "the new holder renews")
      },
    )

    t.it(
      "expired with no one taking over: the old holder's renew is false, but it can acquire again",
      async () => {
        const lease = await factory()
        await lease.acquire("s1", "a", 1)
        await sleep(30)
        assertEqual(await lease.renew("s1", "a", 60_000), false, "no renew after expiry")
        assert(await lease.acquire("s1", "a", 60_000), "acquiring again after expiry must succeed")
      },
    )
  })
}
