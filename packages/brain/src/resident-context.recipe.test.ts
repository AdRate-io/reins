/**
 * 常驻上下文配方（brain README "Resident context that survives compaction"）的可执行版本：README 里的代码就是下面的
 * `memoryIndex` 与 `residentContext`，这里用真循环证明 Boss 认可的口径（2026-10-31）：
 * 开场取一份索引；段内模型自己写了记忆不刷新（写的过程就在上下文里）；整理后按当前实际再取一份，视图里只有一份。
 */
import {
  type CoreEvent,
  type CoreEventOf,
  defineTool,
  type Event,
  InMemoryEventLog,
  InMemoryMemoryStore,
  type MemoryStore,
  type RunResult,
  runLoop,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { compact } from "./compact/index.js"
import { memory } from "./memory/index.js"
import { pins } from "./pins/index.js"

// ---- 配方本体（与 README 逐字一致，改一处要同步另一处）----

/** One line per memory file: the index, not the content. The model opens a file with its `memory` tool. */
function memoryIndex(store: MemoryStore) {
  return async (): Promise<string | undefined> => {
    const paths = await store.list("/memories/")
    if (paths.length === 0) return undefined
    return ["Your memory files (open one with the memory tool):", ...paths.map((p) => `- ${p}`)].join("\n")
  }
}

const residentContext = (store: MemoryStore) =>
  pins({ pins: [{ name: "memory-index", snapshot: memoryIndex(store) }], tool: false })

// ---- 配方本体结束 ----

type Note = CoreEventOf<"core.system_note">
const SESSION = "s1"

const addTool = defineTool<{ a: number; b: number }>({
  name: "add",
  description: "两数相加",
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  execute: ({ a, b }) => a + b,
})

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<RunResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

const indexNotes = (events: readonly Event[]) =>
  events.filter(
    (e): e is Note => e.type === "core.system_note" && (e as Note).payload.meta?.pin !== undefined,
  )

describe("README 配方：常驻记忆索引按段刷新", () => {
  it("开场一份；段内写记忆不刷新；整理后刷新成当前的，视图里只有一份", async () => {
    const store = new InMemoryMemoryStore()
    await store.write("/memories/team.md", "We ship on Fridays.")
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      {
        drafts: [
          callTool("m1", "memory", {
            command: "create",
            path: "/memories/decisions.md",
            file_text: "Use pg.",
          }),
        ],
      },
      { drafts: [callTool("c1", "add", { a: 1, b: 2 })] },
      { drafts: [callTool("k1", "compact", { summary: "Recorded the pg decision.", keep: [] })] },
      { drafts: [say("Done.")] },
    ])
    const result = await drain(
      runLoop({
        sessionId: SESSION,
        log,
        lowering,
        model: { provider: "scripted", id: "scripted" },
        tools: [addTool],
        memory: store,
        systemPrompt: "You are an analyst.",
        input: "Record our database decision.",
        sockets: [residentContext(store), memory(), compact()],
      }),
    )
    expect(result.status).toBe("done")

    // 段内：模型写了 decisions.md，眼前的索引仍是开场那份（写的过程就在上下文里）
    const midSegment = indexNotes(lowering.requests[1]?.events ?? [])
    expect(midSegment.map((n) => n.payload.text)).toEqual([
      "Your memory files (open one with the memory tool):\n- /memories/team.md",
    ])
    // 整理后：写记忆的那段被折走了，索引按当前实际刷新，视图里只有新的一份
    const afterCompaction = indexNotes(lowering.requests[3]?.events ?? [])
    expect(afterCompaction.map((n) => n.payload.text)).toEqual([
      "Your memory files (open one with the memory tool):\n- /memories/decisions.md\n- /memories/team.md",
    ])

    const logged: CoreEvent[] = []
    for await (const e of log.read(SESSION)) logged.push(e as CoreEvent)
    expect(indexNotes(logged)).toHaveLength(2)
  })
})
