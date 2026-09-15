/**
 * D4 跨进程 run 登记：用 core 的 `InMemoryRunLease`（时钟可注入）当两台实例共用的租约表，
 * 每台实例一个 handler + 一个 `leasedRunRegistry`，日志共用一份（模拟同一个数据库）。
 */
import {
  defineTool,
  InMemoryEventLog,
  InMemoryRunLease,
  type RunLease,
  type RunResult,
  type Tool,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, type ScriptedTurn, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { createAgentHandler } from "./handler.js"
import { leasedRunRegistry } from "./leased-runs.js"
import { RunConflictError } from "./runs.js"
import { type Frame, gate, getRequest, openReader, parseFrames, postRequest } from "./test-utils.js"

const MODEL = { provider: "scripted", id: "scripted" }

/** 一个可以从外面卡住的工具 + 用它的两轮剧本 */
function waiting() {
  const g = gate()
  const tool = defineTool<Record<string, never>>({
    name: "wait",
    description: "等闸门",
    inputSchema: { type: "object" },
    execute: async () => {
      await g.wait()
      return "放行"
    },
  })
  const script: ScriptedTurn[] = [
    { drafts: [callTool("c1", "wait", {})] },
    { drafts: [say("完成")] },
    { drafts: [say("下一个 run 的回答")] },
  ]
  return { g, tool, script }
}

/** 一台"实例"：自己的登记表、自己的 owner，与别的实例共用 lease 与 log */
function instance(
  lease: RunLease,
  log: InMemoryEventLog,
  script: ScriptedTurn[],
  tools: Tool[],
  opts: { owner: string; ttlMs?: number; warn?: (m: string) => void },
) {
  const runs = leasedRunRegistry(lease, {
    owner: opts.owner,
    ttlMs: opts.ttlMs ?? 30_000,
    warn: opts.warn ?? (() => {}),
  })
  const handler = createAgentHandler(
    { log, lowering: new ScriptedLowering(script), model: MODEL, tools },
    { heartbeatMs: 0, runs },
  )
  return { runs, handler }
}

const resultIn = (frames: Frame[]) => frames.find((f) => f.event === "result")?.data as RunResult | undefined
const resultOf = (text: string) => resultIn(parseFrames(text))

async function until(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe("D4 leasedRunRegistry：两台实例共用一份租约", () => {
  it("实例 A 在跑：实例 B 的 POST 得 409 run_in_progress（别的实例）；A 跑完释放，B 再 POST 正常起 run", async () => {
    const lease = new InMemoryRunLease()
    const log = new InMemoryEventLog()
    const w = waiting()
    const a = instance(lease, log, w.script, [w.tool], { owner: "A" })
    const b = instance(lease, log, [{ drafts: [say("B 来了")] }, { drafts: [say("B 又来了")] }], [w.tool], {
      owner: "B",
    })

    const first = await openReader(a.handler(postRequest({ sessionId: "s1", input: "go" })))
    await first.until((f) => f.id === "3") // tool_call 已落，run 卡在工具里
    expect(lease.holderOf("s1")).toBe("A")

    const conflict = await b.handler(postRequest({ sessionId: "s1", input: "插队" }))
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      error: "run_in_progress",
      message: expect.stringContaining("on another instance"),
    })
    // 别的会话不受影响
    expect((await b.handler(postRequest({ sessionId: "s2", input: "另一条" }))).status).toBe(200)

    w.g.open()
    await first.rest()
    await a.runs.get("s1")?.done
    expect(lease.holderOf("s1")).toBeUndefined() // done 时已 release
    expect(a.runs.get("s1")).toBeUndefined()

    const again = await b.handler(postRequest({ sessionId: "s1", input: "再来" }))
    expect(again.status).toBe(200)
    expect(resultOf(await again.text())).toMatchObject({ status: "done" })
    expect(lease.holderOf("s1")).toBeUndefined()
  })

  it("GET 只认本进程：本实例的 GET 接上实时流到 result；别的实例的 GET 只补发（live:false）到 end 帧", async () => {
    const lease = new InMemoryRunLease()
    const log = new InMemoryEventLog()
    const w = waiting()
    const a = instance(lease, log, w.script, [w.tool], { owner: "A" })
    const b = instance(lease, log, [], [w.tool], { owner: "B" })

    const first = await openReader(a.handler(postRequest({ sessionId: "s1", input: "go" })))
    await first.until((f) => f.id === "3")

    const local = await openReader(a.handler(getRequest({ sessionId: "s1" })))
    const remote = parseFrames(await (await b.handler(getRequest({ sessionId: "s1" }))).text())
    expect(remote[0]).toMatchObject({ event: "start", data: { live: false } })
    expect(remote.at(-1)).toMatchObject({ event: "end", data: { sessionId: "s1", lastSeq: 3 } })

    w.g.open()
    const localFrames = await local.rest()
    expect(localFrames[0]).toMatchObject({ event: "start", data: { live: true } })
    expect(localFrames.at(-1)?.event).toBe("result")
    await first.rest()
  })

  it("心跳续期失败（租约过期、被别的实例接手）：本 run 被中止以 paused(host) 收场，告警一次；接手者不受影响", async () => {
    let now = 1_000_000
    const lease = new InMemoryRunLease({ now: () => now })
    const log = new InMemoryEventLog()
    const warns: string[] = []
    const w = waiting()
    // ttl 30 ms → 心跳每 10 ms 一次
    const a = instance(lease, log, w.script, [w.tool], { owner: "A", ttlMs: 30, warn: (m) => warns.push(m) })

    const first = await openReader(a.handler(postRequest({ sessionId: "s1", input: "go" })))
    await first.until((f) => f.id === "3")
    const run = a.runs.get("s1")
    expect(run).toBeDefined()

    // 模拟 A 被冻结：时钟一下跳过 ttl，别的实例把租约抢走
    now += 1_000
    expect(await lease.acquire("s1", "B", 60_000)).toBe(true)
    await until(() => run?.controller.signal.aborted === true, "心跳发现丢租约后 abort")
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain("Lost the run lease")

    w.g.open()
    expect(resultIn(await first.rest())).toMatchObject({ status: "paused", reason: "host" })
    await run?.done
    // release 只删自己的：B 的租约原样
    expect(lease.holderOf("s1")).toBe("B")
    // 之后再多等几个心跳周期，不再告警（心跳已停）
    await new Promise((r) => setTimeout(r, 40))
    expect(warns).toHaveLength(1)
  })

  it("renew 抛错（存储抖动）只告警不中止，run 跑完；release 抛错只告警，done 仍 resolve、本进程名额已还", async () => {
    const inner = new InMemoryRunLease()
    const fail = { renew: false, release: false }
    const flaky: RunLease = {
      acquire: (s, o, t) => inner.acquire(s, o, t),
      renew: async (s, o, t) => {
        if (fail.renew) throw new Error("renew 抖动")
        return inner.renew(s, o, t)
      },
      release: async (s, o) => {
        if (fail.release) throw new Error("release 挂了")
        return inner.release(s, o)
      },
    }
    const log = new InMemoryEventLog()
    const warns: string[] = []
    const w = waiting()
    const a = instance(flaky, log, w.script, [w.tool], {
      owner: "A",
      ttlMs: 30,
      warn: (m) => warns.push(m),
    })

    fail.renew = true
    fail.release = true
    const first = await openReader(a.handler(postRequest({ sessionId: "s1", input: "go" })))
    await first.until((f) => f.id === "3")
    await until(() => warns.some((m) => m.includes("Failed to renew the run lease")), "renew-failure warning")
    w.g.open()
    expect(resultIn(await first.rest())).toMatchObject({ status: "done" })
    await a.runs.get("s1")?.done
    expect(warns.some((m) => m.includes("Failed to release the run lease"))).toBe(true)
    // release 失败：租约仍挂在 A 名下，但本进程名额已还；同一 owner 再 acquire 幂等成功 → 再 POST 正常
    expect(inner.holderOf("s1")).toBe("A")
    fail.renew = false
    fail.release = false
    const again = await a.handler(postRequest({ sessionId: "s1", input: "再来" }))
    expect(again.status).toBe(200)
    expect(resultOf(await again.text())).toMatchObject({ status: "done" })
    expect(inner.holderOf("s1")).toBeUndefined()
  })

  it("同进程并发 create 同一会话：只一个成功，另一个 RunConflictError(process)，租约仍归先到者；结束后释放", async () => {
    const lease = new InMemoryRunLease()
    const runs = leasedRunRegistry(lease, { owner: "A", warn: () => {} })
    const settled = await Promise.allSettled([runs.create("s1"), runs.create("s1")])
    const ok = settled.filter((r) => r.status === "fulfilled")
    const bad = settled.filter((r) => r.status === "rejected")
    expect(ok).toHaveLength(1)
    expect(bad).toHaveLength(1)
    expect((bad[0] as PromiseRejectedResult).reason).toBeInstanceOf(RunConflictError)
    expect(((bad[0] as PromiseRejectedResult).reason as RunConflictError).heldBy).toBe("process")
    expect(lease.holderOf("s1")).toBe("A")

    const run = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof runs.create>>>).value
    run.abandon("test", "收工")
    await run.done
    expect(lease.holderOf("s1")).toBeUndefined()
    expect(runs.get("s1")).toBeUndefined()
  })

  it("ActiveRun.done 等收尾钩子：release 还没回来 done 不 resolve；登记表删项在结束那一刻同步生效", async () => {
    const inner = new InMemoryRunLease()
    const release = gate()
    const slow: RunLease = {
      acquire: (s, o, t) => inner.acquire(s, o, t),
      renew: (s, o, t) => inner.renew(s, o, t),
      release: async (s, o) => {
        await release.wait()
        await inner.release(s, o)
      },
    }
    const runs = leasedRunRegistry(slow, { owner: "A", warn: () => {} })
    const run = await runs.create("s1")
    let done = false
    void run.done.then(() => {
      done = true
    })
    run.abandon("test", "收工")
    expect(run.finished).toBe(true)
    expect(runs.get("s1")).toBeUndefined() // 同步删项
    await new Promise((r) => setTimeout(r, 10))
    expect(done).toBe(false) // release 未完成，done 还挂着
    release.open()
    await run.done
    expect(inner.holderOf("s1")).toBeUndefined()
  })

  it("ttlMs 非正数在构造时就拒绝", () => {
    const lease = new InMemoryRunLease()
    expect(() => leasedRunRegistry(lease, { ttlMs: 0 })).toThrow(RangeError)
    expect(() => leasedRunRegistry(lease, { ttlMs: -1 })).toThrow(RangeError)
  })
})
