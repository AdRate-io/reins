/**
 * 图片引用形态（2026-11-24 媒体引用方案，docs/implementation-plans/2026-11-24-媒体引用形态.md）。
 *
 * 机制正确性用假模型：引用只是存储形态，降级层看到的与内联写法逐字节相同，不花真钱。
 * 覆盖验证矩阵里 core 的格子：形状、base64、等价、只换视野内、缓存、取不到、统一文案（三入口）、
 * 工具结果覆盖面、fork、引用集合分离、版本。
 */
import { describe, expect, it } from "vitest"
import type { ContentPart, Event, ImageRefPart } from "../events/base.js"
import type { CoreEvent } from "../events/core.js"
import { createCoreEvent, type EventDraft } from "../events/create.js"
import { createCoreRegistry } from "../events/registry.js"
import type { ToRequestInput } from "../lowering/types.js"
import { StoreError } from "../store/errors.js"
import { InMemoryBlobStore, InMemoryEventLog } from "../store/in-memory.js"
import type { BlobMeta, BlobStore } from "../store/types.js"
import { callTool, ScriptedLowering, type ScriptedTurn, say } from "../testing/scripted-lowering.js"
import {
  blobUsableBy,
  bytesToBase64,
  hydrateImageRefs,
  IMAGE_REF_ID_MAX,
  type ImageRefCache,
  imageRefNotFound,
  isImageRef,
  mediaRefsOf,
} from "./media-refs.js"
import { runLoop } from "./run-loop.js"
import { defineTool, isContentPart } from "./tools.js"
import type { LoopConfig, RunResult, Socket, Tool } from "./types.js"

const MODEL = { provider: "scripted", id: "scripted" }
const registry = createCoreRegistry()
/** 一张"图"的原始字节：含 ≥ 0x80 的字节，防止 base64 实现只对 ASCII 对 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80])
const PNG_B64 = btoa(String.fromCharCode(...PNG))

function deterministic() {
  let t = 1_800_000_000_000
  let n = 0
  return { now: () => ++t, newId: () => `id${++n}` }
}

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<{ events: Event[]; result: RunResult }> {
  const events: Event[] = []
  while (true) {
    const step = await gen.next()
    if (step.done) return { events, result: step.value }
    events.push(step.value)
  }
}

async function all(log: InMemoryEventLog, sessionId: string): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(sessionId)) out.push(e as CoreEvent)
  return out
}

/** 计数 BlobStore：数 get 次数，可注入一次性故障 */
class CountingBlobs implements BlobStore {
  readonly inner = new InMemoryBlobStore()
  gets: string[] = []
  /** 下一次（或每一次）get 抛这个错 */
  failNext: unknown[] = []
  failAlways: unknown | undefined
  put(bytes: Uint8Array | string, meta: { mime: string; sessionId: string }) {
    return this.inner.put(bytes, meta)
  }
  async get(id: string): Promise<{ bytes: Uint8Array; meta: BlobMeta }> {
    this.gets.push(id)
    if (this.failAlways !== undefined) throw this.failAlways
    const next = this.failNext.shift()
    if (next !== undefined) throw next
    return this.inner.get(id)
  }
}

const ref = (blobId: string, mime = "image/png"): ImageRefPart => ({ type: "image", mime, blobId })
const userWith = (...content: ContentPart[]): EventDraft => ({
  type: "core.user_message",
  actor: "user",
  payload: { content },
})

/** 直接往日志里写事件（模拟以前的 run 写下的历史），seq 从当前末尾接着排 */
async function seed(log: InMemoryEventLog, sessionId: string, drafts: readonly EventDraft[]): Promise<void> {
  const tail = (await log.tail(sessionId, 1))[0]?.seq ?? 0
  await log.append(
    drafts.map((d, i) =>
      createCoreEvent(registry, {
        ...(d as Parameters<typeof createCoreEvent>[1]),
        sessionId,
        seq: tail + 1 + i,
        at: 1,
        id: `seed-${sessionId}-${tail + 1 + i}`,
      }),
    ),
  )
}

function base(
  log: InMemoryEventLog,
  lowering: ScriptedLowering,
  extra: Partial<LoopConfig> = {},
  sessionId = "s1",
): LoopConfig {
  return { sessionId, log, lowering, model: MODEL, ...deterministic(), ...extra }
}

/** 某次请求里第 i 条 user_message 的内容 */
function userContentAt(input: ToRequestInput | undefined, i = 0): ContentPart[] | undefined {
  const users = (input?.events ?? []).filter((e) => e.type === "core.user_message") as CoreEvent[]
  const e = users[i]
  return e?.type === "core.user_message" ? e.payload.content : undefined
}

describe("形状（isImageRef / isContentPart）", () => {
  it("合规的引用通过；内联照旧", () => {
    expect(isContentPart(ref("b1"))).toBe(true)
    expect(isImageRef(ref("b1"))).toBe(true)
    expect(isContentPart({ type: "image", mime: "whatever", data: "AA" })).toBe(false)
    expect(isImageRef({ type: "image", mime: "image/png", data: "AA" })).toBe(false)
  })

  it.each([
    ["mime 不是 image/", { type: "image", mime: "text/plain", blobId: "b1" }],
    ["data 与 blobId 并存", { type: "image", mime: "image/png", blobId: "b1", data: "AA" }],
    ["空 blobId", { type: "image", mime: "image/png", blobId: "" }],
    ["超长 blobId", { type: "image", mime: "image/png", blobId: "x".repeat(IMAGE_REF_ID_MAX + 1) }],
    ["blobId 不是字符串", { type: "image", mime: "image/png", blobId: 7 }],
    ["缺 mime", { type: "image", blobId: "b1" }],
  ])("%s → 拒绝", (_label, part) => {
    expect(isContentPart(part)).toBe(false)
  })

  it(`blobId 恰好 ${IMAGE_REF_ID_MAX} 字符通过`, () => {
    expect(isContentPart(ref("x".repeat(IMAGE_REF_ID_MAX)))).toBe(true)
  })
})

describe("bytesToBase64", () => {
  it("≥ 64KB、含 ≥ 0x80 字节的数据往返一致", () => {
    const bytes = new Uint8Array(70_000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 256
    const b64 = bytesToBase64(bytes)
    const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    expect(back).toEqual(bytes)
    expect(bytesToBase64(new Uint8Array())).toBe("")
  })
})

describe("mediaRefsOf / blobUsableBy", () => {
  it("只收 user_message / tool_result 内容里的图片引用，不看 spilled", () => {
    const mk = (type: CoreEvent["type"], payload: unknown, seq: number) =>
      createCoreEvent(registry, {
        type,
        payload,
        actor: type === "core.tool_result" ? "tool" : "user",
        sessionId: "s",
        seq,
        at: 1,
      } as Parameters<typeof createCoreEvent>[1])
    const timeline = [
      mk("core.user_message", { content: [ref("u1"), { type: "text", text: "b9" }] }, 1),
      mk(
        "core.tool_result",
        {
          toolCallId: "c",
          name: "t",
          content: [ref("t1")],
          isError: false,
          spilled: { blobId: "spill1", bytes: 10, mime: "text/plain" },
        },
        2,
      ),
    ]
    expect([...mediaRefsOf(timeline)].sort()).toEqual(["t1", "u1"])
    const meta = { mime: "image/png", sessionId: "other", size: 1, createdAt: 0 }
    expect(blobUsableBy("s", meta, "u1", timeline)).toBe(true)
    expect(blobUsableBy("s", meta, "spill1", timeline)).toBe(false)
    expect(blobUsableBy("s", { ...meta, sessionId: "s" }, "anything", [])).toBe(true)
  })
})

describe("runLoop：换回", () => {
  it("等价：引用写法与内联写法交给降级层的内容逐字相同；日志里只有引用", async () => {
    const blobs = new CountingBlobs()
    const log = new InMemoryEventLog()
    const { id } = await blobs.put(PNG, { mime: "image/png", sessionId: "s1" })
    const byRef = new ScriptedLowering([{ drafts: [say("ok")] }])
    const byInline = new ScriptedLowering([{ drafts: [say("ok")] }])
    await drain(runLoop(base(log, byRef, { blobs, input: [{ type: "text", text: "看" }, ref(id)] }, "s1")))
    await drain(
      runLoop(
        base(log, byInline, {
          blobs,
          input: [
            { type: "text", text: "看" },
            { type: "image", mime: "image/png", data: PNG_B64 },
          ],
        }),
      ),
    )
    // 第二个 run 在同一会话：取它看到的最后一条 user_message
    expect(userContentAt(byRef.requests[0])).toEqual(userContentAt(byInline.requests[0], 1))
    expect(userContentAt(byRef.requests[0])).toEqual([
      { type: "text", text: "看" },
      { type: "image", mime: "image/png", data: PNG_B64 },
    ])
    const stored = (await all(log, "s1")).find((e) => e.type === "core.user_message")
    expect(stored?.type === "core.user_message" && stored.payload.content[1]).toEqual(ref(id))
    expect(stored?.schemaVersion).toBe(2)
  })

  it("Socket 看到的 ctx.events 仍是引用（换回只给 toRequest）", async () => {
    const blobs = new CountingBlobs()
    const log = new InMemoryEventLog()
    const { id } = await blobs.put(PNG, { mime: "image/png", sessionId: "s1" })
    const seen: ContentPart[][] = []
    const spy: Socket = {
      name: "spy",
      beforeModel: (ctx) => {
        for (const e of ctx.events)
          if (e.type === "core.user_message")
            seen.push((e as CoreEvent & { payload: { content: ContentPart[] } }).payload.content)
        return undefined
      },
    }
    await drain(
      runLoop(
        base(log, new ScriptedLowering([{ drafts: [say("ok")] }]), {
          blobs,
          sockets: [spy],
          input: [ref(id)],
        }),
      ),
    )
    expect(seen).toEqual([[ref(id)]])
  })

  it("只换视野内：被 compaction 折叠的引用不调 get", async () => {
    const blobs = new CountingBlobs()
    const log = new InMemoryEventLog()
    const { id } = await blobs.put(PNG, { mime: "image/png", sessionId: "s1" })
    await seed(log, "s1", [
      userWith(ref(id)),
      { type: "core.model_text", actor: "model", payload: { text: "看到了" } },
      {
        type: "core.compaction",
        actor: "model",
        payload: { coversSeq: [1, 2], summary: "用户发过一张图", decidedBy: "model", pinsKept: [] },
      },
    ])
    const lowering = new ScriptedLowering([{ drafts: [say("ok")] }])
    await drain(runLoop(base(log, lowering, { blobs, input: "继续" })))
    expect(blobs.gets).toEqual([])
    expect(userContentAt(lowering.requests[0])).toEqual([{ type: "text", text: "继续" }])
  })

  it("缓存：写入校验后同轮使用、多轮、瞬断重试，同一 blob 只 get 一次", async () => {
    const blobs = new CountingBlobs()
    const log = new InMemoryEventLog()
    const { id } = await blobs.put(PNG, { mime: "image/png", sessionId: "s1" })
    const look: Tool = defineTool({
      name: "look",
      description: "",
      inputSchema: { type: "object" },
      risk: "low",
      execute: () => "done",
    })
    const transient = Object.assign(new Error("503 overloaded"), { status: 503 })
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "look", {})] },
      { drafts: [], throws: transient },
      { drafts: [say("ok")] },
    ])
    const { result } = await drain(
      runLoop(
        base(log, lowering, {
          blobs,
          tools: [look],
          input: [ref(id)],
          retry: { sleep: async () => {} },
        }),
      ),
    )
    expect(result.status).toBe("done")
    expect(lowering.requests).toHaveLength(3)
    for (const r of lowering.requests) expect(userContentAt(r)?.[0]).toMatchObject({ data: PNG_B64 })
    expect(blobs.gets).toEqual([id])
  })
})

describe("runLoop：取不到", () => {
  it("not_found：保持引用交给降级层（落占位由降级层做），run 照跑", async () => {
    const blobs = new CountingBlobs()
    const log = new InMemoryEventLog()
    await seed(log, "s1", [userWith({ type: "text", text: "旧图" }, ref("gone"))])
    const lowering = new ScriptedLowering([{ drafts: [say("ok")] }])
    const { result } = await drain(runLoop(base(log, lowering, { blobs })))
    expect(result.status).toBe("done")
    expect(userContentAt(lowering.requests[0])?.[1]).toEqual(ref("gone"))
    // 失败不进缓存：下一个 run 再问一次
    await drain(runLoop(base(log, new ScriptedLowering([{ drafts: [say("ok")] }]), { blobs, input: "再看" })))
    expect(blobs.gets).toEqual(["gone", "gone"])
  })

  it("没配 BlobStore：日志里的引用原样交给降级层，run 照跑", async () => {
    const log = new InMemoryEventLog()
    await seed(log, "s1", [userWith(ref("b1"))])
    const lowering = new ScriptedLowering([{ drafts: [say("ok")] }])
    const { result } = await drain(runLoop(base(log, lowering)))
    expect(result.status).toBe("done")
    expect(userContentAt(lowering.requests[0])).toEqual([ref("b1")])
  })

  it("其它存储错误：不落占位、不调 toRequest，走模型调用失败（不可重试即 error）", async () => {
    const blobs = new CountingBlobs()
    const log = new InMemoryEventLog()
    await seed(log, "s1", [userWith(ref("b1"))])
    blobs.failAlways = new Error("disk on fire")
    const lowering = new ScriptedLowering([{ drafts: [say("ok")] }])
    const { result } = await drain(runLoop(base(log, lowering, { blobs })))
    expect(result.status).toBe("error")
    expect(result.status === "error" && result.error.payload.message).toBe("disk on fire")
    expect(lowering.requests).toEqual([])
  })

  it("其它存储错误是瞬断时重试，失败不进缓存，第二次取到即换回", async () => {
    const blobs = new CountingBlobs()
    const log = new InMemoryEventLog()
    const { id } = await blobs.put(PNG, { mime: "image/png", sessionId: "s1" })
    await seed(log, "s1", [userWith(ref(id))])
    blobs.failNext.push(Object.assign(new Error("503 storage busy"), { status: 503 }))
    const lowering = new ScriptedLowering([{ drafts: [say("ok")] }])
    const { result, events } = await drain(
      runLoop(base(log, lowering, { blobs, retry: { sleep: async () => {} } })),
    )
    expect(result.status).toBe("done")
    expect(blobs.gets).toEqual([id, id])
    expect(lowering.requests).toHaveLength(1)
    expect(userContentAt(lowering.requests[0])).toEqual([{ type: "image", mime: "image/png", data: PNG_B64 }])
    expect(events.filter((e) => e.type === "core.error")).toHaveLength(1)
  })
})

describe("写入校验：统一文案、越权当不存在", () => {
  /** 四种不合规：别的会话的 blob、不存在、别的会话 + 错 mime、没配 BlobStore；同一会话错 mime 也一样 */
  async function badRefs() {
    const blobs = new CountingBlobs()
    const other = await blobs.put(PNG, { mime: "image/png", sessionId: "other" })
    const otherWrongMime = await blobs.put("text", { mime: "text/plain", sessionId: "other" })
    const ownWrongMime = await blobs.put(PNG, { mime: "image/jpeg", sessionId: "s1" })
    return {
      blobs,
      cases: [
        { label: "别的会话的 blob", part: ref(other.id), withBlobs: true },
        { label: "不存在", part: ref("nope"), withBlobs: true },
        { label: "别的会话 + 错 mime", part: ref(otherWrongMime.id), withBlobs: true },
        { label: "本会话但 mime 不符", part: ref(ownWrongMime.id), withBlobs: true },
        { label: "没配 BlobStore", part: ref(other.id), withBlobs: false },
      ],
    }
  }

  it("起步 input：抛 RangeError，文案逐字相同，一条日志不写", async () => {
    const { blobs, cases } = await badRefs()
    for (const c of cases) {
      const log = new InMemoryEventLog()
      const lowering = new ScriptedLowering([{ drafts: [say("ok")] }])
      const gen = runLoop(
        base(log, lowering, {
          ...(c.withBlobs ? { blobs } : {}),
          input: [{ type: "text", text: "x" }, c.part],
        }),
      )
      await expect(drain(gen), c.label).rejects.toThrow(new RangeError(imageRefNotFound(c.part.blobId)))
      expect(await all(log, "s1"), c.label).toEqual([])
    }
  })

  it("起步 input 校验时存储自己抛错：原样抛出、一条不写", async () => {
    const blobs = new CountingBlobs()
    blobs.failAlways = new Error("disk on fire")
    const log = new InMemoryEventLog()
    const gen = runLoop(base(log, new ScriptedLowering([]), { blobs, input: [ref("b1")] }))
    await expect(drain(gen)).rejects.toThrow("disk on fire")
    expect(await all(log, "s1")).toEqual([])
  })

  it("客户端工具结果草稿（起步 input）同样校验", async () => {
    const { blobs, cases } = await badRefs()
    const c = cases[0]
    if (!c) throw new Error("no case")
    const log = new InMemoryEventLog()
    // 回填的结果须对应一个 pending 调用（全库审查 2026-11-25 #15），先种一条
    await seed(log, "s1", [callTool("c1", "pick", {}) as EventDraft])
    const gen = runLoop(
      base(log, new ScriptedLowering([]), {
        blobs,
        input: {
          type: "core.tool_result",
          actor: "tool",
          payload: { toolCallId: "c1", name: "pick", content: [c.part], isError: false },
        },
      }),
    )
    await expect(drain(gen)).rejects.toThrow(imageRefNotFound(c.part.blobId))
  })

  it("中途 pullInput：以 error 收口，core.error(input) 文案逐字相同", async () => {
    const { blobs, cases } = await badRefs()
    for (const c of cases) {
      const log = new InMemoryEventLog()
      let pulls = 0
      const { result } = await drain(
        runLoop(
          base(log, new ScriptedLowering([{ drafts: [say("ok")] }]), {
            ...(c.withBlobs ? { blobs } : {}),
            input: "起步",
            pullInput: async () => (pulls++ === 0 ? [userWith(c.part)] : []),
          }),
        ),
      )
      expect(result.status, c.label).toBe("error")
      expect(result.status === "error" && result.error.payload).toMatchObject({
        category: "input",
        message: imageRefNotFound(c.part.blobId),
      })
      expect(
        (await all(log, "s1")).filter((e) => e.type === "core.user_message"),
        c.label,
      ).toHaveLength(1)
    }
  })

  it("中途 pullInput 校验时存储抛错：记 core.error(host)、当这次没有，run 照跑", async () => {
    const blobs = new CountingBlobs()
    const { id } = await blobs.put(PNG, { mime: "image/png", sessionId: "s1" })
    blobs.failNext.push(new Error("disk hiccup"))
    const log = new InMemoryEventLog()
    let pulls = 0
    const lowering = new ScriptedLowering([{ drafts: [say("ok")] }])
    const { result } = await drain(
      runLoop(
        base(log, lowering, {
          blobs,
          input: "起步",
          pullInput: async () => (pulls++ === 0 ? [userWith(ref(id))] : []),
        }),
      ),
    )
    expect(result.status).toBe("done")
    const logged = await all(log, "s1")
    const err = logged.find((e) => e.type === "core.error")
    expect(err?.type === "core.error" && err.payload).toMatchObject({ category: "host", retryable: true })
    expect(logged.filter((e) => e.type === "core.user_message")).toHaveLength(1)
  })

  it("合规的中途输入写入并换回", async () => {
    const blobs = new CountingBlobs()
    const { id } = await blobs.put(PNG, { mime: "image/png", sessionId: "s1" })
    const log = new InMemoryEventLog()
    let pulls = 0
    const lowering = new ScriptedLowering([{ drafts: [say("ok")] }])
    await drain(
      runLoop(
        base(log, lowering, {
          blobs,
          input: "起步",
          pullInput: async () => (pulls++ === 0 ? [userWith(ref(id))] : []),
        }),
      ),
    )
    expect(userContentAt(lowering.requests[0], 1)).toEqual([
      { type: "image", mime: "image/png", data: PNG_B64 },
    ])
    expect(blobs.gets).toEqual([id])
  })
})

describe("工具结果里的图片引用", () => {
  async function runTool(tool: Tool, blobs: BlobStore | undefined, sockets: Socket[] = []) {
    const log = new InMemoryEventLog()
    await drain(
      runLoop(
        base(
          log,
          new ScriptedLowering([{ drafts: [callTool("c1", tool.name, {})] }, { drafts: [say("ok")] }]),
          {
            ...(blobs ? { blobs } : {}),
            tools: [tool],
            sockets,
            input: "go",
          },
        ),
      ),
    )
    const result = (await all(log, "s1")).find((e) => e.type === "core.tool_result")
    if (result?.type !== "core.tool_result") throw new Error("no tool_result")
    return result
  }
  const tool = (out: Partial<Tool>): Tool =>
    defineTool({ name: "shot", description: "", inputSchema: { type: "object" }, risk: "low", ...out })

  it("合规的引用照写（存引用）；不合规的那段换成 not found 那句，其余段与 isError 照留", async () => {
    const blobs = new CountingBlobs()
    const own = await blobs.put(PNG, { mime: "image/png", sessionId: "s1" })
    const other = await blobs.put(PNG, { mime: "image/png", sessionId: "other" })
    const ok = await runTool(tool({ execute: () => [ref(own.id)] }), blobs)
    expect(ok.payload).toMatchObject({ isError: false, content: [ref(own.id)] })
    // 写工具已经动过手：结果的文字不能因为一张图不合规而丢掉，模型才不会以为没做成再做一遍
    const mixed = await runTool(
      tool({ execute: () => [{ type: "text", text: "order 42 created" }, ref(other.id), ref(own.id)] }),
      blobs,
    )
    expect(mixed.payload).toMatchObject({
      isError: false,
      content: [
        { type: "text", text: "order 42 created" },
        { type: "text", text: imageRefNotFound(other.id) },
        ref(own.id),
      ],
    })
  })

  it("同一 blob 换个 mime：缓存命中也照比 mime（独立审查：缓存曾只按 blobId 放行）", async () => {
    const blobs = new CountingBlobs()
    const own = await blobs.put(PNG, { mime: "image/png", sessionId: "s1" })
    const log = new InMemoryEventLog()
    // 同一批 input 里先合规、再换 mime：第二段命中缓存
    await expect(
      drain(
        runLoop(
          base(log, new ScriptedLowering([]), { blobs, input: [ref(own.id), ref(own.id, "image/webp")] }),
        ),
      ),
    ).rejects.toThrow(imageRefNotFound(own.id))
    expect(await all(log, "s1")).toEqual([])
    // 历史里已有该图（换回时进了缓存），工具结果换 mime 引用同一 blob
    const r = await runTool(tool({ execute: () => [ref(own.id, "image/gif")] }), blobs)
    expect(r.payload.content).toEqual([{ type: "text", text: imageRefNotFound(own.id) }])
  })

  it("历史里已换回进缓存的图：工具结果换 mime 引用它照样被拒", async () => {
    const blobs = new CountingBlobs()
    const own = await blobs.put(PNG, { mime: "image/png", sessionId: "s1" })
    const log = new InMemoryEventLog()
    await seed(log, "s1", [userWith(ref(own.id))])
    const gif: Tool = tool({ execute: () => [ref(own.id, "image/gif")] })
    await drain(
      runLoop(
        base(log, new ScriptedLowering([{ drafts: [callTool("c1", "shot", {})] }, { drafts: [say("ok")] }]), {
          blobs,
          tools: [gif],
        }),
      ),
    )
    const result = (await all(log, "s1")).find((e) => e.type === "core.tool_result")
    expect(result?.type === "core.tool_result" && result.payload.content).toEqual([
      { type: "text", text: imageRefNotFound(own.id) },
    ])
    // 换回与校验共用一次读取
    expect(blobs.gets).toEqual([own.id])
  })

  it("覆盖面：toModelOutput 输出、isError 结果、afterTool 换掉的结果都校验", async () => {
    const blobs = new CountingBlobs()
    const other = await blobs.put(PNG, { mime: "image/png", sessionId: "other" })
    const viaModelOutput = await runTool(
      tool({ execute: () => "raw", toModelOutput: () => [ref(other.id)] }),
      blobs,
    )
    expect(viaModelOutput.payload.content).toEqual([{ type: "text", text: imageRefNotFound(other.id) }])
    const viaError = await runTool(
      tool({ execute: () => ({ content: [ref(other.id)], isError: true }) }),
      blobs,
    )
    expect(viaError.payload.content).toEqual([{ type: "text", text: imageRefNotFound(other.id) }])
    const swap: Socket = {
      name: "swap",
      afterTool: (_ctx, _call, result) => ({
        ...result,
        payload: { ...result.payload, content: [ref(other.id)] },
      }),
    }
    const viaAfterTool = await runTool(tool({ execute: () => "fine" }), blobs, [swap])
    expect(viaAfterTool.payload.content).toEqual([{ type: "text", text: imageRefNotFound(other.id) }])
  })

  it("没配 BlobStore：同一句 not found", async () => {
    const r = await runTool(tool({ execute: () => [ref("b1")] }), undefined)
    expect(r.payload.content).toEqual([{ type: "text", text: imageRefNotFound("b1") }])
  })

  it("校验时存储抛错：那段回 storage error（不说 not found），原因另记一条模型不可见的 core.error、排在结果之前", async () => {
    const blobs = new CountingBlobs()
    blobs.failAlways = new Error("disk on fire")
    const log = new InMemoryEventLog()
    await drain(
      runLoop(
        base(log, new ScriptedLowering([{ drafts: [callTool("c1", "shot", {})] }, { drafts: [say("ok")] }]), {
          blobs,
          tools: [tool({ execute: () => [ref("b1")] })],
          input: "go",
        }),
      ),
    )
    const logged = await all(log, "s1")
    const at = logged.findIndex((e) => e.type === "core.tool_result")
    const result = logged[at]
    expect(result?.type === "core.tool_result" && result.payload.content).toEqual([
      { type: "text", text: "Could not read blob b1: storage error" },
    ])
    const err = logged[at - 1]
    expect(err?.type === "core.error" && err.payload).toMatchObject({
      category: "host",
      message: expect.stringContaining("disk on fire"),
      detail: { phase: "toolResult" },
    })
  })
})

describe("fork 与引用集合分离", () => {
  it("fork 出的会话：父会话已引用的 blob 可用，父会话未引用的拒绝", async () => {
    const blobs = new CountingBlobs()
    const log = new InMemoryEventLog()
    const used = await blobs.put(PNG, { mime: "image/png", sessionId: "parent" })
    const unused = await blobs.put(PNG, { mime: "image/png", sessionId: "parent" })
    await drain(
      runLoop(
        base(
          log,
          new ScriptedLowering([{ drafts: [say("ok")] }]),
          { blobs, input: [ref(used.id)] },
          "parent",
        ),
      ),
    )
    const atSeq = (await log.tail("parent", 1))[0]?.seq ?? 0
    await log.fork("parent", atSeq, "child")
    const lowering = new ScriptedLowering([{ drafts: [say("ok")] }])
    const { result } = await drain(runLoop(base(log, lowering, { blobs, input: [ref(used.id)] }, "child")))
    expect(result.status).toBe("done")
    await expect(
      drain(runLoop(base(log, new ScriptedLowering([]), { blobs, input: [ref(unused.id)] }, "child"))),
    ).rejects.toThrow(imageRefNotFound(unused.id))
  })

  it("图片引用不能指向外溢 blob（mime 不符，同一句 not found）", async () => {
    const blobs = new CountingBlobs()
    const spilled = await blobs.put("a big tool result", { mime: "text/plain", sessionId: "s1" })
    const log = new InMemoryEventLog()
    await expect(
      drain(runLoop(base(log, new ScriptedLowering([]), { blobs, input: [ref(spilled.id)] }))),
    ).rejects.toThrow(imageRefNotFound(spilled.id))
  })
})

describe("hydrateImageRefs", () => {
  it("没有引用的事件原样返回同一对象；not_found 不进缓存", async () => {
    const e = createCoreEvent(registry, {
      type: "core.user_message",
      payload: { content: [{ type: "text", text: "hi" }] },
      actor: "user",
      sessionId: "s",
      seq: 1,
      at: 1,
    })
    const cache: ImageRefCache = new Map()
    const [same] = await hydrateImageRefs([e], { blobs: new InMemoryBlobStore(), cache })
    expect(same).toBe(e)
    const withRef = { ...e, payload: { content: [ref("gone")] } }
    const [kept] = await hydrateImageRefs([withRef], { blobs: new InMemoryBlobStore(), cache })
    expect((kept as typeof withRef).payload.content).toEqual([ref("gone")])
    expect(cache.size).toBe(0)
  })

  it("非 not_found 的 StoreError 照样抛", async () => {
    const blobs: BlobStore = {
      put: async () => ({ id: "x" }),
      get: async () => {
        throw new StoreError("invalid_argument", "bad")
      },
    }
    const e = createCoreEvent(registry, {
      type: "core.user_message",
      payload: { content: [ref("b1")] },
      actor: "user",
      sessionId: "s",
      seq: 1,
      at: 1,
    })
    await expect(hydrateImageRefs([e], { blobs, cache: new Map() })).rejects.toThrow(/invalid_argument/)
  })
})

describe("版本", () => {
  it("新写的 user_message / tool_result 是 v2，实时与读回一致", async () => {
    const log = new InMemoryEventLog()
    const look: Tool = defineTool({
      name: "look",
      description: "",
      inputSchema: { type: "object" },
      risk: "low",
      execute: () => "x",
    })
    const turns: ScriptedTurn[] = [{ drafts: [callTool("c1", "look", {})] }, { drafts: [say("ok")] }]
    const { events } = await drain(
      runLoop(base(log, new ScriptedLowering(turns), { tools: [look], input: "hi" })),
    )
    const live = events.filter((e) => e.type === "core.user_message" || e.type === "core.tool_result")
    expect(live.map((e) => e.schemaVersion)).toEqual([2, 2])
    const stored = (await all(log, "s1")).filter(
      (e) => e.type === "core.user_message" || e.type === "core.tool_result",
    )
    expect(stored.map((e) => e.schemaVersion)).toEqual([2, 2])
  })
})
