/**
 * RunLease 一致性套件（D4）。过期一项用真时间等（ttl 1 ms、等 30 ms）：套件不知道后端的时钟怎么注入，
 * 而 Postgres 实现刻意用数据库时间，测试时钟只能是真时钟。
 */
import type { RunLease } from "../store/types.js"
import { assert, assertEqual, type TestHarness } from "./harness.js"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function runLeaseConformance(t: TestHarness, factory: () => RunLease | Promise<RunLease>): void {
  t.describe("RunLease 一致性", () => {
    t.it("空会话 acquire 成功；别人未过期时再 acquire 失败；会话之间互不影响", async () => {
      const lease = await factory()
      assertEqual(await lease.acquire("s1", "a", 60_000), true, "首次占用")
      assertEqual(await lease.acquire("s1", "b", 60_000), false, "别人持有中")
      assertEqual(await lease.acquire("s2", "b", 60_000), true, "另一会话不受影响")
    })

    t.it("同一 owner 重复 acquire 幂等成功（等于续期），不改变持有关系", async () => {
      const lease = await factory()
      assertEqual(await lease.acquire("s1", "a", 60_000), true, "首次")
      assertEqual(await lease.acquire("s1", "a", 60_000), true, "自己再占")
      assertEqual(await lease.acquire("s1", "b", 60_000), false, "别人仍占不到")
      assertEqual(await lease.renew("s1", "a", 60_000), true, "自己仍能续")
    })

    t.it("renew：持有者成功；非持有者失败；从未占过的会话失败", async () => {
      const lease = await factory()
      await lease.acquire("s1", "a", 60_000)
      assertEqual(await lease.renew("s1", "a", 60_000), true, "持有者续期")
      assertEqual(await lease.renew("s1", "b", 60_000), false, "非持有者")
      assertEqual(await lease.renew("nope", "a", 60_000), false, "不存在的会话")
    })

    t.it("release：持有者释放后别人可占；非持有者释放无效；释放不存在的会话不报错", async () => {
      const lease = await factory()
      await lease.acquire("s1", "a", 60_000)
      await lease.release("s1", "b") // 不是自己的，不该动
      assertEqual(await lease.acquire("s1", "b", 60_000), false, "非持有者 release 后 a 仍持有")
      await lease.release("s1", "a")
      assertEqual(await lease.acquire("s1", "b", 60_000), true, "持有者 release 后可再占")
      await lease.release("nope", "a") // 幂等
    })

    t.it("过期：到期后别人能接手，原持有者 renew 为 false；接手者续期正常", async () => {
      const lease = await factory()
      assertEqual(await lease.acquire("s1", "a", 1), true, "短租约")
      await sleep(30)
      assertEqual(await lease.acquire("s1", "b", 60_000), true, "过期后接手")
      assertEqual(await lease.renew("s1", "a", 60_000), false, "丢了租约的一方续期失败")
      assertEqual(await lease.renew("s1", "b", 60_000), true, "接手者续期")
    })

    t.it("过期但无人接手：原持有者 renew 为 false，但可以重新 acquire", async () => {
      const lease = await factory()
      await lease.acquire("s1", "a", 1)
      await sleep(30)
      assertEqual(await lease.renew("s1", "a", 60_000), false, "过期后不能续")
      assert(await lease.acquire("s1", "a", 60_000), "过期后重新占用应成功")
    })
  })
}
