/**
 * 图片引用并发读取（2026-11-24 AdRate 建议 18，docs/implementation-plans/2026-11-24-图片引用并发读取.md）。
 *
 * 全部假模型与假存储，不花真钱。并发效果用带延迟的计数存储测：每次 get / stat 延迟 D 毫秒、记录在途峰值，
 * 判据是在途峰值与读取次数（确定性：串行实现峰值恒为 1），不断言耗时——墙钟在忙的 CI 上会抖。覆盖验证矩阵里 core 的格子：换回并发、去重、读取次数（进程内）、
 * 校验顺序、返回 null、换回错误、合批入口、工具结果、metaOnly。
 */
import { describe, expect, it } from "vitest"
import type { ContentPart, Event, ImageRefPart } from "../events/base.js"
import type { CoreEvent } from "../events/core.js"
import { createCoreEvent, type EventDraft } from "../events/create.js"
import { createCoreRegistry } from "../events/registry.js"
import { StoreError } from "../store/errors.js"
import { InMemoryBlobStore, InMemoryEventLog } from "../store/in-memory.js"
import type { BlobMeta, BlobStore } from "../store/types.js"
import { callTool, ScriptedLowering, say } from "../testing/scripted-lowering.js"
import {
  BLOB_READ_CONCURRENCY,
  checkImageRefs,
  hydrateImageRefs,
  type ImageRefCache,
  imageRefNotFound,
} from "./media-refs.js"
import { runLoop } from "./run-loop.js"
import { defineTool } from "./tools.js"
import type { LoopConfig, RunResult } from "./types.js"

const MODEL = { provider: "scripted", id: "scripted" }
const registry = createCoreRegistry()
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x80])
const PNG_B64 = btoa(String.fromCharCode(...PNG))
/** 每次读取的延迟（毫秒） */
const D = 40

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const ref = (blobId: string, mime = "image/png"): ImageRefPart => ({ type: "image", mime, blobId })
const userWith = (...content: ContentPart[]): EventDraft => ({
  type: "core.user_message",
  actor: "user",
  payload: { content },
})

/**
 * 带延迟的计数存储：get 与（可选的）stat 每次延迟 D 毫秒，记读取次数与在途峰值；
 * 可按 id 注入延迟、错误、返回 null
 */
class DelayedBlobs implements BlobStore {
  readonly inner = new InMemoryBlobStore()
  gets: string[] = []
  stats: string[] = []
  inFlight = 0
  peak = 0
  delayOf = new Map<string, number>()
  failOf = new Map<string, unknown>()
  /** 对不存在的 id 返回 null（照 R2 head() 写错的宿主） */
  nullForMissing = false
  /** 覆盖 stat 报的 mime（模拟登记表与对象不一致） */
  statMime: string | undefined

  put(bytes: Uint8Array | string, meta: { mime: string; sessionId: string }) {
    return this.inner.put(bytes, meta)
  }

  protected async read<T>(id: string, run: () => Promise<T>): Promise<T> {
    this.inFlight++
    this.peak = Math.max(this.peak, this.inFlight)
    try {
      await sleep(this.delayOf.get(id) ?? D)
      const fail = this.failOf.get(id)
      if (fail !== undefined) throw fail
      return await run()
    } finally {
      this.inFlight--
    }
  }

  get(id: string): Promise<{ bytes: Uint8Array; meta: BlobMeta }> {
    this.gets.push(id)
    return this.read(id, async () => {
      try {
        return await this.inner.get(id)
      } catch (err) {
        if (this.nullForMissing) return null as unknown as { bytes: Uint8Array; meta: BlobMeta }
        throw err
      }
    })
  }
}

/** 同上，另实现 stat（按方法调用：靠 this 读 inner） */
class DelayedBlobsWithStat extends DelayedBlobs {
  stat(id: string): Promise<BlobMeta> {
    this.stats.push(id)
    return this.read(id, async () => {
      try {
        const meta = (await this.inner.get(id)).meta
        return this.statMime === undefined ? meta : { ...meta, mime: this.statMime }
      } catch (err) {
        if (this.nullForMissing) return null as unknown as BlobMeta
        throw err
      }
    })
  }
}

async function putMany(blobs: DelayedBlobs, n: number, sessionId = "s1"): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push((await blobs.put(PNG, { mime: "image/png", sessionId })).id)
  return ids
}

function userEvent(seq: number, content: ContentPart[]): Event {
  return createCoreEvent(registry, {
    type: "core.user_message",
    actor: "user",
    payload: { content },
    sessionId: "s1",
    seq,
    at: 1,
  })
}

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<{ events: Event[]; result: RunResult }> {
  const events: Event[] = []
  while (true) {
    const step = await gen.next()
    if (step.done) return { events, result: step.value }
    events.push(step.value)
  }
}

async function all(log: InMemoryEventLog, sessionId = "s1"): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(sessionId)) out.push(e as CoreEvent)
  return out
}

function base(log: InMemoryEventLog, lowering: ScriptedLowering, extra: Partial<LoopConfig>): LoopConfig {
  let t = 1_800_000_000_000
  let n = 0
  return {
    sessionId: "s1",
    log,
    lowering,
    model: MODEL,
    now: () => ++t,
    newId: () => `id${++n}`,
    ...extra,
  }
}

describe("换回并发", () => {
  it(`视野内 10 张未缓存的图一波读完（在途峰值 10）；${BLOB_READ_CONCURRENCY * 2 + 8} 张时在途峰值 = ${BLOB_READ_CONCURRENCY}`, async () => {
    const blobs = new DelayedBlobs()
    const ten = await putMany(blobs, 10)
    const events = ten.map((id, i) => userEvent(i + 1, [ref(id)]))
    const value = await hydrateImageRefs(events, { blobs, cache: new Map() })
    expect(blobs.peak).toBe(10)
    // 按原顺序换回，与内联写法逐字节相等
    for (const e of value) {
      expect((e as CoreEvent & { payload: { content: ContentPart[] } }).payload.content).toEqual([
        { type: "image", mime: "image/png", data: PNG_B64 },
      ])
    }

    const many = new DelayedBlobs()
    const ids = await putMany(many, BLOB_READ_CONCURRENCY * 2 + 8)
    await hydrateImageRefs(
      [
        userEvent(
          1,
          ids.map((id) => ref(id)),
        ),
      ],
      { blobs: many, cache: new Map() },
    )
    expect(many.peak).toBe(BLOB_READ_CONCURRENCY)
    expect(many.gets).toHaveLength(ids.length)
  })
})

describe("去重", () => {
  it("视野内同一 blob 出现三次、同一张不存在的图出现两次：各只读一次", async () => {
    const blobs = new DelayedBlobs()
    const [id] = await putMany(blobs, 1)
    if (id === undefined) throw new Error("no id")
    const cache: ImageRefCache = new Map()
    const out = await hydrateImageRefs(
      [userEvent(1, [ref(id), ref("gone")]), userEvent(2, [ref(id)]), userEvent(3, [ref(id), ref("gone")])],
      { blobs, cache },
    )
    expect(blobs.gets.filter((g) => g === id)).toHaveLength(1)
    expect(blobs.gets.filter((g) => g === "gone")).toHaveLength(1)
    // 不存在的保持引用（降级层落占位），不进缓存
    expect((out[2] as CoreEvent & { payload: { content: ContentPart[] } }).payload.content[1]).toEqual(
      ref("gone"),
    )
    expect([...cache.keys()]).toEqual([id])
  })

  it("一条消息引用同一 blob 两次：写入校验只读一次", async () => {
    const blobs = new DelayedBlobs()
    const [id] = await putMany(blobs, 1)
    if (id === undefined) throw new Error("no id")
    const problem = await checkImageRefs([ref(id), { type: "text", text: "再看" }, ref(id)], {
      sessionId: "s1",
      blobs,
      timeline: [],
      cache: new Map(),
    })
    expect(problem).toBeUndefined()
    expect(blobs.gets).toEqual([id])
  })
})

describe("校验顺序：按片段顺序报第一个问题，与完成先后无关", () => {
  it("第 1 段存储抛错且后完成、第 3 段 not_found：抛第 1 段的错", async () => {
    const blobs = new DelayedBlobs()
    const [a, b] = await putMany(blobs, 2)
    if (a === undefined || b === undefined) throw new Error("no id")
    blobs.delayOf.set(a, D * 2)
    blobs.delayOf.set("missing", 1)
    blobs.failOf.set(a, new Error("first broke"))
    await expect(
      checkImageRefs([ref(a), ref(b), ref("missing")], {
        sessionId: "s1",
        blobs,
        timeline: [],
        cache: new Map(),
      }),
    ).rejects.toThrow("first broke")
  })

  it("第 1 段越权、第 2 段 not_found：报第 1 段那句", async () => {
    const blobs = new DelayedBlobs()
    const [other] = await putMany(blobs, 1, "other")
    if (other === undefined) throw new Error("no id")
    blobs.delayOf.set(other, D * 2)
    blobs.delayOf.set("missing", 1)
    const problem = await checkImageRefs([ref(other), ref("missing")], {
      sessionId: "s1",
      blobs,
      timeline: [],
      cache: new Map(),
    })
    expect(problem).toBe(imageRefNotFound(other))
  })
})

describe("返回值不是对象当 not_found（防探测）", () => {
  it("get / stat 对不存在的 id 返回 null：统一那句，不是抛 TypeError", async () => {
    for (const blobs of [new DelayedBlobs(), new DelayedBlobsWithStat()]) {
      blobs.nullForMissing = true
      for (const metaOnly of [false, true]) {
        const problem = await checkImageRefs([ref("nope")], {
          sessionId: "s1",
          blobs,
          timeline: [],
          cache: new Map(),
          metaOnly,
        })
        expect(problem).toBe(imageRefNotFound("nope"))
      }
    }
  })

  it("换回时 get 返回 null：保持引用（与 not_found 同处置）", async () => {
    const blobs = new DelayedBlobs()
    blobs.nullForMissing = true
    const [out] = await hydrateImageRefs([userEvent(1, [ref("nope")])], { blobs, cache: new Map() })
    expect((out as CoreEvent & { payload: { content: ContentPart[] } }).payload.content).toEqual([
      ref("nope"),
    ])
  })

  it("宿主同步抛错也只是这一个 blob 的失败，不冲出池子", async () => {
    const blobs: BlobStore = {
      put: async () => ({ id: "x" }),
      get: (id: string) => {
        if (id === "sync") throw new Error("sync boom")
        return Promise.reject(new StoreError("not_found", "nope"))
      },
    }
    await expect(
      checkImageRefs([ref("other"), ref("sync")], { sessionId: "s1", blobs, timeline: [], cache: new Map() }),
    ).resolves.toBe(imageRefNotFound("other"))
    await expect(
      checkImageRefs([ref("sync"), ref("other")], { sessionId: "s1", blobs, timeline: [], cache: new Map() }),
    ).rejects.toThrow("sync boom")
  })
})

describe("metaOnly（server 预校验用）", () => {
  it("有 stat 用 stat、不读字节、不进缓存；没有 stat 退回 get、也不进缓存", async () => {
    const withStat = new DelayedBlobsWithStat()
    const [id] = await putMany(withStat, 1)
    if (id === undefined) throw new Error("no id")
    const cache: ImageRefCache = new Map()
    const ctx = { sessionId: "s1", timeline: [], cache, metaOnly: true }
    expect(await checkImageRefs([ref(id)], { ...ctx, blobs: withStat })).toBeUndefined()
    expect(withStat.stats).toEqual([id])
    expect(withStat.gets).toEqual([])
    expect(cache.size).toBe(0)
    // 归属与 mime 照判
    expect(await checkImageRefs([ref(id, "image/jpeg")], { ...ctx, blobs: withStat })).toBe(
      imageRefNotFound(id),
    )

    const plain = new DelayedBlobs()
    const [id2] = await putMany(plain, 1)
    if (id2 === undefined) throw new Error("no id")
    expect(await checkImageRefs([ref(id2)], { ...ctx, blobs: plain })).toBeUndefined()
    expect(plain.gets).toEqual([id2])
    expect(cache.size).toBe(0)
  })
})

describe("换回错误", () => {
  it("两张同时失败、后面那张先失败：抛视野里靠前那张的错；成功的进缓存，重试只重读失败的", async () => {
    const blobs = new DelayedBlobs()
    const [a, b, ok] = await putMany(blobs, 3)
    if (a === undefined || b === undefined || ok === undefined) throw new Error("no id")
    blobs.delayOf.set(a, D * 2)
    blobs.delayOf.set(b, 1)
    blobs.failOf.set(a, new Error("a broke"))
    blobs.failOf.set(b, new Error("b broke"))
    const cache: ImageRefCache = new Map()
    const events = [userEvent(1, [ref(a)]), userEvent(2, [ref(ok), ref(b)])]
    await expect(hydrateImageRefs(events, { blobs, cache })).rejects.toThrow("a broke")
    expect([...cache.keys()]).toEqual([ok])
    blobs.failOf.clear()
    blobs.gets = []
    await hydrateImageRefs(events, { blobs, cache })
    expect(blobs.gets.sort()).toEqual([a, b].sort())
  })

  it("一张 not_found 一张成功：前者保持引用、后者换回", async () => {
    const blobs = new DelayedBlobs()
    const [ok] = await putMany(blobs, 1)
    if (ok === undefined) throw new Error("no id")
    const [out] = await hydrateImageRefs([userEvent(1, [ref("gone"), ref(ok)])], { blobs, cache: new Map() })
    expect((out as CoreEvent & { payload: { content: ContentPart[] } }).payload.content).toEqual([
      ref("gone"),
      { type: "image", mime: "image/png", data: PNG_B64 },
    ])
  })
})

describe("runLoop：合批入口与读取次数", () => {
  it("起步 input 三条草稿各带图：一波并发读完，每张只 get 一次（换回复用缓存、不调 stat）", async () => {
    const blobs = new DelayedBlobsWithStat()
    const ids = await putMany(blobs, 3)
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [say("ok")] }])
    const { result } = await drain(
      runLoop(base(log, lowering, { blobs, input: ids.map((id) => userWith(ref(id))) })),
    )
    expect(result.status).toBe("done")
    expect(blobs.peak).toBe(3)
    expect(blobs.gets.sort()).toEqual([...ids].sort())
    expect(blobs.stats).toEqual([])
  })

  it("起步 input 合批后报的第一个问题与逐条串行相同：第 2 条草稿越权、第 3 条不存在 → 第 2 条那句", async () => {
    const blobs = new DelayedBlobs()
    const [mine] = await putMany(blobs, 1)
    const [other] = await putMany(blobs, 1, "other")
    if (mine === undefined || other === undefined) throw new Error("no id")
    blobs.delayOf.set(other, D * 2)
    const log = new InMemoryEventLog()
    await expect(
      drain(
        runLoop(
          base(log, new ScriptedLowering([]), {
            blobs,
            input: [userWith(ref(mine)), userWith(ref(other)), userWith(ref("missing"))],
          }),
        ),
      ),
    ).rejects.toThrow(imageRefNotFound(other))
    expect(await all(log)).toHaveLength(0)
  })

  it("pullInput 拉到两条带图：一波并发读完，写入并换回", async () => {
    const blobs = new DelayedBlobs()
    const ids = await putMany(blobs, 2)
    const log = new InMemoryEventLog()
    let pulls = 0
    const lowering = new ScriptedLowering([{ drafts: [say("ok")] }])
    const { result } = await drain(
      runLoop(
        base(log, lowering, {
          blobs,
          input: "起步",
          pullInput: async () => (pulls++ === 0 ? ids.map((id) => userWith(ref(id))) : []),
        }),
      ),
    )
    expect(result.status).toBe("done")
    expect(blobs.peak).toBe(2)
    expect(blobs.gets.sort()).toEqual([...ids].sort())
    expect((await all(log)).filter((e) => e.type === "core.user_message")).toHaveLength(3)
  })

  it("pullInput 合批：第 1 条越权、第 2 条不存在 → error 收口，文案是第 1 条那句", async () => {
    const blobs = new DelayedBlobs()
    const [other] = await putMany(blobs, 1, "other")
    if (other === undefined) throw new Error("no id")
    const log = new InMemoryEventLog()
    let pulls = 0
    const { result } = await drain(
      runLoop(
        base(log, new ScriptedLowering([{ drafts: [say("ok")] }]), {
          blobs,
          input: "起步",
          pullInput: async () => (pulls++ === 0 ? [userWith(ref(other)), userWith(ref("missing"))] : []),
        }),
      ),
    )
    expect(result.status === "error" && result.error.payload).toMatchObject({
      category: "input",
      message: imageRefNotFound(other),
    })
  })
})

describe("runLoop：工具结果", () => {
  async function runShot(blobs: BlobStore, content: ContentPart[]) {
    const tool = defineTool({
      name: "shot",
      description: "",
      inputSchema: { type: "object" },
      risk: "low",
      execute: () => content,
    })
    const log = new InMemoryEventLog()
    await drain(
      runLoop(
        base(log, new ScriptedLowering([{ drafts: [callTool("c1", "shot", {})] }, { drafts: [say("ok")] }]), {
          blobs,
          tools: [tool],
          input: "go",
        }),
      ),
    )
    return all(log)
  }

  it("一条结果三个引用：并发预读、只读一次（换回复用缓存）", async () => {
    const blobs = new DelayedBlobs()
    const ids = await putMany(blobs, 3)
    const logged = await runShot(
      blobs,
      ids.map((id) => ref(id)),
    )
    expect(blobs.peak).toBe(3)
    expect(blobs.gets.sort()).toEqual([...ids].sort())
    const result = logged.find((e) => e.type === "core.tool_result")
    expect(result?.type === "core.tool_result" && result.payload.content).toEqual(ids.map((id) => ref(id)))
  })

  it("同一张图出现两次且读取瞬断：两段都回 storage error、只读一次；其余段照留", async () => {
    const blobs = new DelayedBlobs()
    const [bad, ok] = await putMany(blobs, 2)
    if (bad === undefined || ok === undefined) throw new Error("no id")
    blobs.failOf.set(bad, new Error("flaky"))
    const logged = await runShot(blobs, [ref(bad), { type: "text", text: "说明" }, ref(ok), ref(bad)])
    expect(blobs.gets.filter((g) => g === bad)).toHaveLength(1)
    const result = logged.find((e) => e.type === "core.tool_result")
    const storageError = { type: "text", text: `Could not read blob ${bad}: storage error` }
    expect(result?.type === "core.tool_result" && result.payload.content).toEqual([
      storageError,
      { type: "text", text: "说明" },
      ref(ok),
      storageError,
    ])
    // 存储错误归因与现状一致：每段一条模型不可见的 core.error
    expect(
      logged.filter((e) => e.type === "core.error" && e.payload.detail?.phase === "toolResult"),
    ).toHaveLength(2)
  })
})
