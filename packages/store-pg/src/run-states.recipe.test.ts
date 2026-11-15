/**
 * 会话运行状态配方（store-pg README "Session status for a session list"）的可执行版本：README 里的代码就是下面两个函数，
 * 这里用 PGlite + 真循环 + 真租约证明每种徽标都判得出（AdRate 建议 11 / 12，2026-11-15）。
 */
import { PGlite } from "@electric-sql/pglite"
import { defineTool, type RunStatus, runLoop } from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { afterAll, describe, expect, it } from "vitest"
import { type PgClient, PgRunLease, pgRunStates, pgStores } from "./index.js"

// ---- 配方本体（与 README 逐字一致，改一处要同步另一处）----

/** One badge per session in a list. `lastReadAt` is your own "user opened it" timestamp. */
function badgeOf(status: RunStatus, lastReadAt: number): string {
  switch (status.state) {
    case "running":
      return "running"
    case "paused":
      return status.awaiting && status.awaiting.length > 0 ? "needs you" : "paused"
    case "error":
    case "interrupted":
      return "failed"
    case "done":
    case "handoff":
      return status.endedAt > lastReadAt ? "unread" : ""
    default:
      return "" // idle, or unknown (written by an older version or the TanStack adapter)
  }
}

/** Refuse to delete a session while a run holds it. */
async function canDelete(client: PgClient, sessionId: string): Promise<boolean> {
  const status = (await pgRunStates(client, [sessionId])).get(sessionId)
  return status?.state !== "running"
}

// ---- 配方本体结束 ----

const pglite = new PGlite()
afterAll(() => pglite.close())
const MODEL = { provider: "scripted", id: "scripted" }

describe("README 配方：会话列表的运行状态", () => {
  it("跑完未读 / 等人处理 / 出错 / 在跑 / 新会话各自一个徽标；在跑的不能删", async () => {
    const store = await pgStores(pglite)
    await pglite.query("TRUNCATE reins_events, reins_blobs, reins_memory, reins_runs")
    const deploy = defineTool<Record<string, never>>({
      name: "deploy",
      description: "",
      inputSchema: {},
      needsApproval: true,
      execute: () => "ok",
    })
    const run = async (sessionId: string, script: ConstructorParameters<typeof ScriptedLowering>[0]) => {
      for await (const _ of runLoop({
        sessionId,
        log: store.log,
        lowering: new ScriptedLowering(script),
        model: MODEL,
        tools: [deploy],
        input: "go",
      })) {
        // 跑到底
      }
    }
    await run("done", [{ drafts: [say("好")] }])
    await run("waiting", [{ drafts: [callTool("c1", "deploy", {})] }])
    await run("failed", [{ drafts: [], outcome: { stopReason: "error", errorMessage: "boom" } }])
    await new PgRunLease(pglite).acquire("busy", "A", 60_000)

    const ids = ["done", "waiting", "failed", "busy", "new"]
    const states = await pgRunStates(pglite, ids)
    const badges = ids.map((id) => badgeOf(states.get(id) ?? { state: "unknown" }, 0))
    expect(badges).toEqual(["unread", "needs you", "failed", "running", ""])
    expect(badgeOf(states.get("done") ?? { state: "unknown" }, Number.MAX_SAFE_INTEGER)).toBe("")
    expect(await canDelete(pglite, "busy")).toBe(false)
    expect(await canDelete(pglite, "done")).toBe(true)
  })
})
