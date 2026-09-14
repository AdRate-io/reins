/**
 * 跨包用例（D4）：两个 `@reinsjs/server` handler 各自一个 `leasedRunRegistry`，共用同一个 PGlite 里的 `PgRunLease` 与 `PgEventLog`——
 * 这就是"两台实例连同一个 Postgres"的形状。第二个实例的 POST 必须 409；第一个跑完释放后第二个能接着跑。
 */
import { PGlite } from "@electric-sql/pglite"
import { defineTool, type RunResult } from "@reinsjs/core"
import { callTool, ScriptedLowering, type ScriptedTurn, say } from "@reinsjs/core/testing"
import { createAgentHandler, leasedRunRegistry } from "@reinsjs/server"
import { afterAll, describe, expect, it } from "vitest"
import { pgStores } from "./index.js"

const pglite = new PGlite()
afterAll(() => pglite.close())

const MODEL = { provider: "scripted", id: "scripted" }

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, wait: () => promise }
}

function post(body: unknown): Request {
  return new Request("http://test/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const resultOf = (fs: { event: string | undefined; data: unknown }[]) =>
  fs.find((f) => f.event === "result")?.data as RunResult | undefined

const frames = (text: string) =>
  text
    .split("\n\n")
    .filter((b) => b.trim() !== "")
    .map((b) => {
      const event = b
        .split("\n")
        .find((l) => l.startsWith("event: "))
        ?.slice(7)
      const data = b
        .split("\n")
        .find((l) => l.startsWith("data: "))
        ?.slice(6)
      return { event, data: data === undefined ? undefined : (JSON.parse(data) as unknown) }
    })

describe("跨包：两个 handler + PGlite 租约", () => {
  it("实例 A 卡在工具里时实例 B 的 POST 409；A 跑完后 reins_runs 清空，B 起 run 成功", async () => {
    const store = await pgStores(pglite)
    await pglite.query("TRUNCATE reins_events, reins_blobs, reins_memory, reins_runs")
    const lease = store.runLease
    if (lease === undefined) throw new Error("pgStores 应带 runLease")

    const g = gate()
    const wait = defineTool<Record<string, never>>({
      name: "wait",
      description: "等闸门",
      inputSchema: { type: "object" },
      execute: async () => {
        await g.wait()
        return "放行"
      },
    })
    const mk = (owner: string, script: ScriptedTurn[]) =>
      createAgentHandler(
        { log: store.log, lowering: new ScriptedLowering(script), model: MODEL, tools: [wait] },
        { heartbeatMs: 0, runs: leasedRunRegistry(lease, { owner, ttlMs: 30_000, warn: () => {} }) },
      )
    const a = mk("A", [{ drafts: [callTool("c1", "wait", {})] }, { drafts: [say("A 完成")] }])
    const b = mk("B", [{ drafts: [say("B 完成")] }])

    const first = await a(post({ sessionId: "s1", input: "go" }))
    expect(first.status).toBe(200)
    // 等 A 真正占到租约（POST 返回 200 时 create 已经 await 过 acquire）
    expect((await pglite.query("SELECT owner FROM reins_runs WHERE session_id = $1", ["s1"])).rows).toEqual([
      { owner: "A" },
    ])

    const conflict = await b(post({ sessionId: "s1", input: "插队" }))
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: "run_in_progress" })

    g.open()
    const firstFrames = frames(await first.text())
    expect(resultOf(firstFrames)).toMatchObject({ status: "done" })
    // result 帧之后 release 可能还差一个微任务：轮询到表清空为止（最多 1 s）
    const start = Date.now()
    while (
      (await pglite.query<{ n: number }>("SELECT count(*)::int AS n FROM reins_runs")).rows[0]?.n !== 0
    ) {
      if (Date.now() - start > 1000) throw new Error("A 结束后租约未释放")
      await new Promise((r) => setTimeout(r, 5))
    }

    const second = await b(post({ sessionId: "s1", input: "再来" }))
    expect(second.status).toBe(200)
    const secondFrames = frames(await second.text())
    expect(resultOf(secondFrames)).toMatchObject({ status: "done" })
    // 两个 run 都落在同一条日志里，seq 连续
    const seqs = (
      await pglite.query<{ seq: number }>("SELECT seq FROM reins_events WHERE session_id = $1 ORDER BY seq", [
        "s1",
      ])
    ).rows.map((r) => r.seq)
    expect(seqs).toEqual(seqs.map((_, i) => i + 1))
  })
})
