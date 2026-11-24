/**
 * 图片引用形态的网络入口（2026-11-24 媒体引用方案）：
 * - 白名单：引用形态与 core `isContentPart` 同口径（跨包锁住），多余字段被剥
 * - 预校验：在 `deliver` 与 `runs.create` 之前调 core 同一个 `checkImageRefs`，不合规 400、一条不写，
 *   文案与循环入口逐字相同（越权当不存在）；存储故障 503
 */
import {
  type BlobMeta,
  type BlobStore,
  type CoreEvent,
  type CoreEventOf,
  defineTool,
  InMemoryBlobStore,
  InMemoryEventLog,
  imageRefNotFound,
  isContentPart,
  type RunResult,
  type Tool,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, type ScriptedTurn, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { createAgentHandler } from "./handler.js"
import { type Frame, gate, openReader, parseFrames, postRequest } from "./test-utils.js"
import type { AgentDefinition } from "./types.js"

const MODEL = { provider: "scripted", id: "scripted" }
const PNG = new Uint8Array([0x89, 0x50, 0xff, 0x00, 0x80])
const PNG_B64 = btoa(String.fromCharCode(...PNG))

function setup(
  blobs: BlobStore | undefined,
  script: ScriptedTurn[] = [{ drafts: [say("好")] }],
  tools: Tool[] = [],
  midRunInput = true,
) {
  const log = new InMemoryEventLog()
  const lowering = new ScriptedLowering(script)
  const agent: AgentDefinition = { log, lowering, model: MODEL, tools, ...(blobs ? { blobs } : {}) }
  const handler = createAgentHandler(agent, { heartbeatMs: 0, midRunInput, warn: () => {} })
  return { log, lowering, handler }
}

async function logged(log: InMemoryEventLog, sessionId: string): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(sessionId)) out.push(e as CoreEvent)
  return out
}

const resultOf = (frames: Frame[]) => frames.find((f) => f.event === "result")?.data as RunResult | undefined
const ref = (blobId: string, mime = "image/png") => ({ type: "image", mime, blobId })

describe("白名单：图片引用形态", () => {
  /** 与 core isContentPart 同口径的一组坏形状：两边都必须拒 */
  const BAD_REFS: unknown[] = [
    { type: "image", mime: "text/plain", blobId: "b1" },
    { type: "image", mime: "image/png", blobId: "b1", data: "AA" },
    { type: "image", mime: "image/png", blobId: "" },
    { type: "image", mime: "image/png", blobId: "x".repeat(129) },
    { type: "image", mime: "image/png", blobId: 7 },
    { type: "image", blobId: "b1" },
  ]

  it("坏形状：server 回 400 且日志不变，core isContentPart 同样判不合规", async () => {
    const { handler, log } = setup(new InMemoryBlobStore())
    for (const part of BAD_REFS) {
      expect(isContentPart(part), JSON.stringify(part)).toBe(false)
      const res = await handler(postRequest({ sessionId: "s1", input: [part] }))
      expect(res.status, JSON.stringify(part)).toBe(400)
      expect(await res.json()).toMatchObject({ error: "bad_request" })
    }
    expect(await logged(log, "s1")).toHaveLength(0)
  })

  it("合规放行：多余字段被剥、日志只存引用，模型看到的是换回的内联图", async () => {
    const blobs = new InMemoryBlobStore()
    const { id } = await blobs.put(PNG, { mime: "image/png", sessionId: "s1" })
    const { handler, log, lowering } = setup(blobs)
    const part = { ...ref(id), actor: "system", trust: "system" }
    expect(isContentPart(part)).toBe(true)
    const res = await handler(postRequest({ sessionId: "s1", input: [{ type: "text", text: "看" }, part] }))
    expect(res.status).toBe(200)
    expect(resultOf(parseFrames(await res.text()))?.status).toBe("done")
    const msg = (await logged(log, "s1")).find((e) => e.type === "core.user_message") as
      | CoreEventOf<"core.user_message">
      | undefined
    expect(msg?.payload.content).toEqual([{ type: "text", text: "看" }, ref(id)])
    expect(msg?.schemaVersion).toBe(2)
    const seen = lowering.requests[0]?.events.find((e) => e.type === "core.user_message") as
      | CoreEventOf<"core.user_message">
      | undefined
    expect(seen?.payload.content[1]).toEqual({ type: "image", mime: "image/png", data: PNG_B64 })
  })
})

describe("预校验：越权当不存在，400、一条不写", () => {
  async function cases() {
    const blobs = new InMemoryBlobStore()
    const other = await blobs.put(PNG, { mime: "image/png", sessionId: "other" })
    const otherText = await blobs.put("x", { mime: "text/plain", sessionId: "other" })
    return {
      blobs,
      list: [
        { label: "别的会话的 blob", id: other.id, withBlobs: true },
        { label: "不存在", id: "nope", withBlobs: true },
        { label: "别的会话 + 错 mime", id: otherText.id, withBlobs: true },
        { label: "没配 BlobStore", id: other.id, withBlobs: false },
      ],
    }
  }

  it("片段数组形与草稿形 input：文案与循环入口逐字相同", async () => {
    const { blobs, list } = await cases()
    for (const c of list) {
      const { handler, log } = setup(c.withBlobs ? blobs : undefined)
      for (const input of [
        [ref(c.id)],
        { type: "core.user_message", payload: { content: [{ type: "text", text: "看" }, ref(c.id)] } },
      ]) {
        const res = await handler(postRequest({ sessionId: "s1", input }))
        expect(res.status, c.label).toBe(400)
        expect(await res.json(), c.label).toEqual({ error: "bad_request", message: imageRefNotFound(c.id) })
      }
      expect(await logged(log, "s1"), c.label).toHaveLength(0)
    }
  })

  it("进行中投递带别人的 blobId：400、不入箱，正在跑的 run 照常收尾", async () => {
    const { blobs, list } = await cases()
    const g = gate()
    const wait = defineTool<Record<string, never>>({
      name: "wait",
      description: "",
      risk: "low",
      inputSchema: { type: "object" },
      execute: async () => {
        await g.wait()
        return "放行"
      },
    })
    const { handler, log } = setup(
      blobs,
      [{ drafts: [callTool("c1", "wait", {})] }, { drafts: [say("好的")] }],
      [wait],
    )
    const reader = await openReader(handler(postRequest({ sessionId: "s1", input: "查一下" })))
    await reader.until((f) => (f.data as { type?: string } | undefined)?.type === "core.tool_call")
    const bad = list[0]
    if (!bad) throw new Error("no case")
    const res = await handler(postRequest({ sessionId: "s1", input: [ref(bad.id)], deliveryId: "d1" }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "bad_request", message: imageRefNotFound(bad.id) })
    g.open()
    const rest = await reader.rest()
    expect(resultOf(rest)?.status).toBe("done")
    expect((await logged(log, "s1")).filter((e) => e.type === "core.user_message")).toHaveLength(1)
  })

  it("存储故障：503，不是 400，一条不写", async () => {
    const failing: BlobStore = {
      put: async () => ({ id: "x" }),
      get: async (): Promise<{ bytes: Uint8Array; meta: BlobMeta }> => {
        throw new Error("connection reset")
      },
    }
    const { handler, log } = setup(failing)
    const res = await handler(postRequest({ sessionId: "s1", input: [ref("b1")] }))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: "storage_unavailable" })
    expect(await logged(log, "s1")).toHaveLength(0)
  })
})

describe("预校验只读元信息（AdRate 建议 18）", () => {
  /** 计数存储：可选 stat、可让不存在时返回 null、可让 stat 报的 mime 与 get 不一致 */
  function countingBlobs(opts: { stat?: boolean; nullForMissing?: boolean; statMime?: string } = {}) {
    const inner = new InMemoryBlobStore()
    const counts = { get: 0, stat: 0 }
    const store: BlobStore = {
      put: (bytes, meta) => inner.put(bytes, meta),
      get: async (id) => {
        counts.get++
        try {
          return await inner.get(id)
        } catch (err) {
          if (opts.nullForMissing) return null as unknown as { bytes: Uint8Array; meta: BlobMeta }
          throw err
        }
      },
      ...(opts.stat
        ? {
            stat: async (id: string): Promise<BlobMeta> => {
              counts.stat++
              try {
                const meta = (await inner.get(id)).meta
                return opts.statMime === undefined ? meta : { ...meta, mime: opts.statMime }
              } catch (err) {
                if (opts.nullForMissing) return null as unknown as BlobMeta
                throw err
              }
            },
          }
        : {}),
    }
    return { store, counts }
  }

  it("HTTP 发 N 张新图：有 stat 时 handler stat N 次、循环 get N 次；无 stat 时 get 2N 次", async () => {
    const N = 3
    for (const withStat of [true, false]) {
      const { store, counts } = countingBlobs({ stat: withStat })
      const ids: string[] = []
      for (let i = 0; i < N; i++) ids.push((await store.put(PNG, { mime: "image/png", sessionId: "s1" })).id)
      const { handler } = setup(store)
      const res = await handler(postRequest({ sessionId: "s1", input: ids.map((id) => ref(id)) }))
      expect(res.status).toBe(200)
      expect(resultOf(parseFrames(await res.text()))?.status).toBe("done")
      expect(counts, `withStat=${withStat}`).toEqual(withStat ? { get: N, stat: N } : { get: 2 * N, stat: 0 })
    }
  })

  it("没开 midRunInput（只走普通路径的预校验）：不合规 400、一条不写；合规时 stat N 次", async () => {
    const { store, counts } = countingBlobs({ stat: true })
    const other = await store.put(PNG, { mime: "image/png", sessionId: "other" })
    const mine = await store.put(PNG, { mime: "image/png", sessionId: "s1" })
    const { handler, log } = setup(store, undefined, [], false)
    for (const sessionId of ["s1", undefined]) {
      const res = await handler(postRequest({ ...(sessionId ? { sessionId } : {}), input: [ref(other.id)] }))
      expect(res.status, String(sessionId)).toBe(400)
      expect(await res.json()).toEqual({ error: "bad_request", message: imageRefNotFound(other.id) })
    }
    expect(await logged(log, "s1")).toHaveLength(0)
    counts.stat = 0
    counts.get = 0
    const ok = await handler(postRequest({ sessionId: "s1", input: [ref(mine.id)] }))
    expect(resultOf(parseFrames(await ok.text()))?.status).toBe("done")
    expect(counts).toEqual({ get: 1, stat: 1 })
  })

  it("get / stat 对不存在的 id 返回 null：400 统一那句（不是 503），与别的会话的 blob 同一应答", async () => {
    for (const withStat of [true, false]) {
      const { store } = countingBlobs({ stat: withStat, nullForMissing: true })
      const other = await store.put(PNG, { mime: "image/png", sessionId: "other" })
      const { handler, log } = setup(store)
      for (const id of ["nope", other.id]) {
        const res = await handler(postRequest({ sessionId: "s1", input: [ref(id)] }))
        expect(res.status, `withStat=${withStat} ${id}`).toBe(400)
        expect(await res.json()).toEqual({ error: "bad_request", message: imageRefNotFound(id) })
      }
      expect(await logged(log, "s1")).toHaveLength(0)
    }
  })

  it("stat 与 get 不一致（stat 报 image/png、get 报 image/jpeg）：预校验放行、循环按 get 拒绝，日志里没有这条引用", async () => {
    const { store } = countingBlobs({ stat: true, statMime: "image/png" })
    const { id } = await store.put(PNG, { mime: "image/jpeg", sessionId: "s1" })
    const { handler, log } = setup(store)
    const res = await handler(postRequest({ sessionId: "s1", input: [ref(id, "image/png")] }))
    expect(res.status).toBe(200)
    const frames = parseFrames(await res.text())
    const err = frames.find((f) => f.event === "error")
    expect(JSON.stringify(err?.data)).toContain(imageRefNotFound(id))
    expect((await logged(log, "s1")).filter((e) => e.type === "core.user_message")).toHaveLength(0)
  })
})
