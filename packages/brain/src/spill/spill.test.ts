import {
  type CoreEvent,
  type CoreEventOf,
  createCoreEvent,
  createCoreRegistry,
  defineTool,
  type Event,
  InMemoryBlobStore,
  InMemoryEventLog,
  type LoopConfig,
  type RunResult,
  runLoop,
  type Tool,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { perception } from "../perception/index.js"
import { clipEndByTokens, countLines, measureText, previewOf } from "./preview.js"
import { SPILL_RULES } from "./rules.js"
import { isTextMime, parseFetchBlobArgs, SPILL_BLOB_MIME, spill } from "./spill.js"

const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"
const registry = createCoreRegistry()
type ToolResult = CoreEventOf<"core.tool_result">
type SystemNote = CoreEventOf<"core.system_note">

function deterministic() {
  let t = 1_800_000_000_000
  let n = 0
  return { now: () => ++t, newId: () => `id${++n}` }
}

/** 生成 n 行编号文本："line 1", "line 2", … */
const lines = (n: number, prefix = "line") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n")

/** 一个把 args.text 原样吐回的工具；测试用它控制结果大小 */
const echoTool = (extra: Partial<Tool> = {}): Tool =>
  defineTool<{ text: string; isError?: boolean }>({
    name: "echo",
    description: "原样返回",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    execute: ({ text, isError }) => (isError ? { content: [{ type: "text", text }], isError: true } : text),
    ...(extra as object),
  })

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<{ events: Event[]; result: RunResult }> {
  const events: Event[] = []
  while (true) {
    const step = await gen.next()
    if (step.done) return { events, result: step.value }
    events.push(step.value)
  }
}

async function all(log: InMemoryEventLog): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(SESSION)) out.push(e as CoreEvent)
  return out
}

const types = (events: readonly Event[]) => events.map((e) => e.type.replace("core.", ""))
const resultOf = (events: readonly Event[], toolCallId: string) =>
  events.find(
    (e): e is ToolResult =>
      e.type === "core.tool_result" && (e as ToolResult).payload.toolCallId === toolCallId,
  ) as ToolResult
const textOf = (r: ToolResult) => (r.payload.content[0]?.type === "text" ? r.payload.content[0].text : "")

function config(
  lowering: ScriptedLowering,
  log: InMemoryEventLog,
  extra: Partial<LoopConfig> = {},
): LoopConfig {
  return {
    sessionId: SESSION,
    log,
    blobs: new InMemoryBlobStore(),
    lowering,
    model: MODEL,
    tools: [echoTool()],
    systemPrompt: "你是回声",
    input: "试试",
    // 缺省 16000 token 上限太大，测试用小上限：预览首尾 3 行、每侧 80 字符
    sockets: [spill({ maxResultTokens: 200, previewLines: 3, previewChars: 80 })],
    ...deterministic(),
    ...extra,
  }
}

/** 造一个不追加新 user_message 的配置（种子日志已有内容），exactOptionalPropertyTypes 下不能写 input: undefined */
function spillConfigNoInput(
  lowering: ScriptedLowering,
  log: InMemoryEventLog,
  blobs: InMemoryBlobStore,
): LoopConfig {
  const { input: _input, ...rest } = config(lowering, log, { blobs })
  return rest
}

const echo = (id: string, text: string, isError?: boolean) =>
  callTool(id, "echo", isError ? { text, isError } : { text })

// 1000 行英文 ≈ 每行 "line NNNN" 9~10 字符 → 约 2.5k token，远超 200
const BIG = lines(1000)

describe("spill × runLoop：结果外溢", () => {
  it("fetch_blob 与规则提示是静态贡献：每轮工具表与系统提示逐字相同", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [echo("c1", "hi")] }, { drafts: [say("hi")] }])
    await drain(runLoop(config(lowering, log)))
    expect(lowering.requests).toHaveLength(2)
    for (const req of lowering.requests) {
      expect(req.systemPrompt).toBe(`你是回声\n\n${SPILL_RULES}`)
      expect(req.tools?.map((t) => t.name)).toEqual(["echo", "fetch_blob"])
    }
  })

  it("小结果原样通过：草稿一字不改，没有 spilled", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [echo("c1", "hello\nworld")] }, { drafts: [say("ok")] }])
    await drain(runLoop(config(lowering, log)))
    const r = resultOf(await all(log), "c1")
    expect(r.payload).toEqual({
      toolCallId: "c1",
      name: "echo",
      content: [{ type: "text", text: "hello\nworld" }],
      isError: false,
    })
  })

  it("大结果外溢：全文进 BlobStore，模型看到说明 + 首尾预览，tool_result.spilled 记下 blob；日志只有一条 tool_result", async () => {
    const log = new InMemoryEventLog()
    const blobs = new InMemoryBlobStore()
    const lowering = new ScriptedLowering([{ drafts: [echo("c1", BIG)] }, { drafts: [say("看到了")] }])
    const { result } = await drain(runLoop(config(lowering, log, { blobs })))
    expect(result.status).toBe("done")

    const logged = await all(log)
    expect(types(logged)).toEqual([
      "tools_bound", // 起步的工具表快照，模型不可见
      "user_message",
      "tool_call",
      "tool_result",
      "budget_usage",
      "model_text",
      "budget_usage",
    ])
    const r = resultOf(logged, "c1")
    expect(r.payload.isError).toBe(false)
    expect(r.payload.spilled).toBeDefined()
    const { blobId, summary } = r.payload.spilled as { blobId: string; summary: string }

    // 全文原样在 blob 里
    const stored = await blobs.get(blobId)
    expect(new TextDecoder().decode(stored.bytes)).toBe(BIG)
    expect(stored.meta).toMatchObject({ mime: "text/plain; charset=utf-8", sessionId: SESSION })
    expect(summary).toContain("1,000 lines")
    expect(summary).toContain(blobId)

    // 模型看到的：一段文本，含 id、取回指引、首 3 行、省略标记、尾 3 行
    expect(r.payload.content).toHaveLength(1)
    const text = textOf(r)
    expect(text).toContain(`blob "${blobId}"`)
    expect(text).toContain(`fetch_blob({ id: "${blobId}", start: 0, end: `)
    expect(text).toContain("the inline limit is 200 tokens")
    expect(text).toContain("\nline 1\nline 2\nline 3\n[... ")
    expect(text).toMatch(/omitted \.\.\.\]\nline 998\nline 999\nline 1000$/)
    expect(text).not.toContain("line 500")
    // 替换后的结果远小于上限
    expect(measureText(text).tokens).toBeLessThan(200)

    // 下一轮模型看到的正是替换后的结果
    const seen = lowering.requests[1]?.events.find((e) => e.type === "core.tool_result") as ToolResult
    expect(seen.payload).toEqual(r.payload)
  })

  it("错误结果同样外溢，isError 保留", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [echo("c1", BIG, true)] }, { drafts: [say("x")] }])
    await drain(runLoop(config(lowering, log)))
    const r = resultOf(await all(log), "c1")
    expect(r.payload.isError).toBe(true)
    expect(r.payload.spilled).toBeDefined()
    expect(textOf(r)).toContain("too large to show inline")
  })

  it("图片片段不度量、不外溢，原样跟在预览之后", async () => {
    const log = new InMemoryEventLog()
    const image = { type: "image" as const, mime: "image/png", data: "AAAA" }
    const tool = defineTool<Record<string, never>>({
      name: "shot",
      description: "截图带日志",
      inputSchema: { type: "object" },
      execute: () => [{ type: "text", text: BIG }, image],
    })
    const lowering = new ScriptedLowering([{ drafts: [callTool("c1", "shot", {})] }, { drafts: [say("x")] }])
    await drain(runLoop(config(lowering, log, { tools: [tool] })))
    const r = resultOf(await all(log), "c1")
    expect(r.payload.spilled).toBeDefined()
    expect(r.payload.content).toHaveLength(2)
    expect(r.payload.content[1]).toEqual(image)
  })

  describe("fetch_blob 取回", () => {
    /** 先让 echo 外溢一次，再按 fetchArgs（函数，拿到 blobId 后算）调 fetch_blob */
    async function spillThenFetch(fetchArgs: (blobId: string) => unknown, extra: Partial<LoopConfig> = {}) {
      const log = new InMemoryEventLog()
      const blobs = new InMemoryBlobStore()
      const lowering = new ScriptedLowering((input, turn) => {
        if (turn === 0) return { drafts: [echo("c1", BIG)] }
        if (turn === 1) {
          const first = input.events.find((e) => e.type === "core.tool_result") as ToolResult
          const blobId = (first.payload.spilled as { blobId: string }).blobId
          return { drafts: [callTool("f1", "fetch_blob", fetchArgs(blobId))] }
        }
        return { drafts: [say("done")] }
      })
      const { result } = await drain(runLoop(config(lowering, log, { blobs, ...extra })))
      expect(result.status).toBe("done")
      const logged = await all(log)
      return {
        fetched: resultOf(logged, "f1"),
        spilledId: (resultOf(logged, "c1").payload.spilled as { blobId: string }).blobId,
        blobs,
      }
    }

    it("按字符偏移取一段：头部说明范围、总长、行数与下一段起点；结果不再外溢", async () => {
      const { fetched, spilledId } = await spillThenFetch((id) => ({ id, start: 7, end: 20 }))
      expect(fetched.payload.isError).toBe(false)
      expect(fetched.payload.spilled).toBeUndefined()
      expect(textOf(fetched)).toBe(
        `[blob "${spilledId}": characters 7–20 of ${BIG.length.toLocaleString("en-US")} (1,000 lines total). Continue with start: 20.]\n${BIG.slice(7, 20)}`,
      )
    })

    it("不带范围：从头读，超过上限时按 token 裁并告知续读位置", async () => {
      const { fetched } = await spillThenFetch((id) => ({ id }))
      const text = textOf(fetched)
      const header = text.slice(0, text.indexOf("\n"))
      const body = text.slice(text.indexOf("\n") + 1)
      expect(header).toContain("characters 0–")
      expect(header).toContain("clipped to fit 200 tokens")
      expect(header).toMatch(/Continue with start: (\d+)\.\]$/)
      const next = Number(/Continue with start: (\d+)\./.exec(header)?.[1])
      expect(body).toBe(BIG.slice(0, next))
      expect(measureText(body).tokens).toBeLessThanOrEqual(200)
      expect(clipEndByTokens(BIG, 200)).toBe(next)
    })

    it("读到末尾：告知这是结尾；end 越界截断到总长", async () => {
      const { fetched } = await spillThenFetch((id) => ({
        id,
        start: BIG.length - 10,
        end: BIG.length + 999,
      }))
      expect(textOf(fetched)).toContain("This is the end of the output.]\n")
      expect(textOf(fetched).endsWith(BIG.slice(-10))).toBe(true)
    })

    it("start 越过末尾 → isError", async () => {
      const { fetched } = await spillThenFetch((id) => ({ id, start: BIG.length }))
      expect(fetched.payload.isError).toBe(true)
      expect(textOf(fetched)).toContain("at or beyond the end")
    })

    it("不存在的 id、未被本会话引用的 blob、二进制 blob 都拒绝；越权的当不存在", async () => {
      const blobs = new InMemoryBlobStore()
      const foreign = await blobs.put("secret of s2", { mime: "text/plain", sessionId: "s2" })
      const binary = await blobs.put(new Uint8Array([0, 1, 2]), { mime: "image/png", sessionId: SESSION })
      const log = new InMemoryEventLog()
      const lowering = new ScriptedLowering([
        {
          drafts: [
            callTool("f1", "fetch_blob", { id: "nope" }),
            callTool("f2", "fetch_blob", { id: foreign.id }),
            callTool("f3", "fetch_blob", { id: binary.id }),
          ],
        },
        { drafts: [say("x")] },
      ])
      await drain(runLoop(config(lowering, log, { blobs })))
      const logged = await all(log)
      expect(textOf(resultOf(logged, "f1"))).toBe(`No blob with id "nope" in this session.`)
      expect(textOf(resultOf(logged, "f2"))).toBe(`No blob with id "${foreign.id}" in this session.`)
      // binary 虽属本会话，但没有任何 tool_result 引用它 → 也当不存在（授权按"本会话引用过"，不按 meta.sessionId）
      expect(textOf(resultOf(logged, "f3"))).toBe(`No blob with id "${binary.id}" in this session.`)
      for (const id of ["f1", "f2", "f3"]) expect(resultOf(logged, id).payload.isError).toBe(true)
    })

    it("被本会话 tool_result.spilled 引用的 blob 可读，哪怕它属于别的会话（fork 场景）", async () => {
      // 造一个属于父会话 s0 的 blob，内容够大；直接把它写进本会话日志的一条 tool_result.spilled（模拟 fork 复制过来的结果）
      const blobs = new InMemoryBlobStore()
      const parent = await blobs.put(lines(500), { mime: SPILL_BLOB_MIME, sessionId: "s0" })
      const log = new InMemoryEventLog()
      const seed = createCoreEvent(registry, {
        type: "core.tool_result",
        actor: "tool",
        sessionId: SESSION,
        seq: 1,
        at: 1,
        id: "seed",
        payload: {
          toolCallId: "old",
          name: "echo",
          content: [{ type: "text", text: "[preview]" }],
          isError: false,
          spilled: { blobId: parent.id, summary: "from parent" },
        },
      } as Parameters<typeof createCoreEvent>[1])
      await log.append([seed as Event])
      const lowering = new ScriptedLowering([
        { drafts: [callTool("f1", "fetch_blob", { id: parent.id, start: 0, end: 40 })] },
        { drafts: [say("读到了")] },
      ])
      await drain(runLoop(spillConfigNoInput(lowering, log, blobs)))
      const res = resultOf(await all(log), "f1")
      expect(res.payload.isError).toBe(false)
      expect(textOf(res)).toContain(`blob "${parent.id}"`)
    })

    it("入参不合法 → 循环以 isError 告知（validate 抛错）", async () => {
      const log = new InMemoryEventLog()
      const lowering = new ScriptedLowering([
        {
          drafts: [
            callTool("f1", "fetch_blob", { id: "" }),
            callTool("f2", "fetch_blob", { id: "x", start: 5, end: 5 }),
          ],
        },
        { drafts: [say("x")] },
      ])
      await drain(runLoop(config(lowering, log)))
      const logged = await all(log)
      expect(textOf(resultOf(logged, "f1"))).toContain("Invalid arguments")
      expect(textOf(resultOf(logged, "f2"))).toContain("`end` must be greater than `start`")
    })

    it("没有 BlobStore 时 fetch_blob 明确报错", async () => {
      const log = new InMemoryEventLog()
      const lowering = new ScriptedLowering([
        { drafts: [callTool("f1", "fetch_blob", { id: "x" })] },
        { drafts: [say("x")] },
      ])
      const cfg = config(lowering, log)
      delete cfg.blobs
      await drain(runLoop(cfg))
      const r = resultOf(await all(log), "f1")
      expect(r.payload.isError).toBe(true)
      expect(textOf(r)).toContain("No blob store is configured")
    })
  })

  describe("工具的 resultPolicy", () => {
    it("overflow: truncate → 不存 blob、无 spilled，说明里明说中段不可恢复", async () => {
      const log = new InMemoryEventLog()
      const blobs = new InMemoryBlobStore()
      let puts = 0
      const origPut = blobs.put.bind(blobs)
      blobs.put = (...a) => {
        puts++
        return origPut(...a)
      }
      const tool = echoTool({ resultPolicy: { overflow: "truncate" } })
      const lowering = new ScriptedLowering([{ drafts: [echo("c1", BIG)] }, { drafts: [say("x")] }])
      await drain(runLoop(config(lowering, log, { blobs, tools: [tool] })))
      const r = resultOf(await all(log), "c1")
      expect(puts).toBe(0)
      expect(r.payload.spilled).toBeUndefined()
      const text = textOf(r)
      expect(text).toContain("was truncated")
      expect(text).toContain("cannot be recovered")
      expect(text).toContain("\nline 1\nline 2\nline 3\n[... ")
      expect(text).toMatch(/line 1000$/)
    })

    it("maxTokens 按工具覆盖模块缺省：紧的工具外溢，宽松的工具原样通过", async () => {
      const log = new InMemoryEventLog()
      const tight = echoTool({ name: "tight", resultPolicy: { maxTokens: 10, overflow: "spill" } })
      const loose = echoTool({ name: "loose", resultPolicy: { maxTokens: 100_000, overflow: "spill" } })
      const medium = lines(150) // ≈ 300 token：超模块缺省 200，超 tight 的 10，不超 loose 的 100k
      const lowering = new ScriptedLowering([
        {
          drafts: [
            callTool("t", "tight", { text: medium }),
            callTool("l", "loose", { text: medium }),
            callTool("e", "echo", { text: medium }),
          ],
        },
        { drafts: [say("x")] },
      ])
      await drain(runLoop(config(lowering, log, { tools: [tight, loose, echoTool()] })))
      const logged = await all(log)
      expect(resultOf(logged, "t").payload.spilled).toBeDefined()
      expect(resultOf(logged, "l").payload.spilled).toBeUndefined()
      expect(textOf(resultOf(logged, "l"))).toBe(medium)
      expect(resultOf(logged, "e").payload.spilled).toBeDefined()
    })
  })

  it("没有 BlobStore：外溢关闭，大结果原样通过并告警一次；声明 truncate 的工具照常截断", async () => {
    const log = new InMemoryEventLog()
    const warnings: string[] = []
    const socket = spill({
      maxResultTokens: 200,
      previewLines: 3,
      previewChars: 80,
      warn: (m) => warnings.push(m),
    })
    const trunc = echoTool({ name: "trunc", resultPolicy: { overflow: "truncate" } })
    const lowering = new ScriptedLowering([
      { drafts: [echo("c1", BIG), echo("c2", BIG), callTool("c3", "trunc", { text: BIG })] },
      { drafts: [say("x")] },
    ])
    const cfg = config(lowering, log, { sockets: [socket], tools: [echoTool(), trunc] })
    delete cfg.blobs
    await drain(runLoop(cfg))
    const logged = await all(log)
    expect(textOf(resultOf(logged, "c1"))).toBe(BIG)
    expect(textOf(resultOf(logged, "c2"))).toBe(BIG)
    expect(resultOf(logged, "c1").payload.spilled).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("No BlobStore configured")
    expect(textOf(resultOf(logged, "c3"))).toContain("was truncated")
  })

  it('perception 的"可见外溢结果数"能看见本模块的外溢', async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [echo("c1", BIG), echo("c2", BIG), echo("c3", BIG)] },
      { drafts: [say("x")] },
    ])
    await drain(
      runLoop(
        config(lowering, log, {
          sockets: [perception(), spill({ maxResultTokens: 200, previewLines: 3, previewChars: 80 })],
        }),
      ),
    )
    const notes = (await all(log)).filter(
      (e): e is SystemNote =>
        e.type === "core.system_note" && (e as SystemNote).payload.kind === "perception",
    )
    expect(notes).toHaveLength(2) // 首轮一条，外溢后档位变了再一条
    expect(notes[1]?.payload.text).toContain("Tool results spilled out of the context")
  })

  it("构造期校验：非法上限与预览参数拒绝", () => {
    expect(() => spill({ maxResultTokens: 0 })).toThrow(RangeError)
    expect(() => spill({ maxResultTokens: 1.5 })).toThrow(RangeError)
    expect(() => spill({ previewLines: -1 })).toThrow(RangeError)
    expect(() => spill({ previewChars: -1 })).toThrow(RangeError)
    expect(() => spill()).not.toThrow()
    expect(spill({ tool: false }).tools).toBeUndefined()
    expect(spill({ tool: false }).systemPrompt).toBeUndefined()
    expect(spill({ rules: false }).systemPrompt).toBeUndefined()
    expect(spill({ rules: "自定义" }).systemPrompt).toBe("自定义")
  })
})

describe("spill 纯函数", () => {
  it("countLines：空串 0 行，末尾换行不多算", () => {
    expect(countLines("")).toBe(0)
    expect(countLines("a")).toBe(1)
    expect(countLines("a\nb")).toBe(2)
    expect(countLines("a\nb\n")).toBe(2)
  })

  it("previewOf：头尾重叠时全文即 head，tail 为空", () => {
    expect(previewOf(lines(5), { lines: 3, chars: 1000 })).toEqual({
      head: lines(5),
      tail: "",
      omitted: { chars: 0, lines: 0 },
    })
  })

  it("previewOf：头尾各 N 行，中段省略量精确", () => {
    const text = lines(10)
    const p = previewOf(text, { lines: 2, chars: 1000 })
    expect(p.head).toBe("line 1\nline 2\n")
    expect(p.tail).toBe("line 9\nline 10")
    expect(p.head + text.slice(p.head.length, text.length - p.tail.length) + p.tail).toBe(text)
    expect(p.omitted).toEqual({ chars: text.length - p.head.length - p.tail.length, lines: 6 })
  })

  it("previewOf：单行超长按字符裁", () => {
    const text = "x".repeat(100)
    const p = previewOf(text, { lines: 3, chars: 10 })
    expect(p.head).toBe("x".repeat(10))
    expect(p.tail).toBe("x".repeat(10))
    expect(p.omitted).toEqual({ chars: 80, lines: 1 })
  })

  it("clipEndByTokens：ASCII 4 字一 token，非 ASCII 一字一 token，不够裁返回全长", () => {
    expect(clipEndByTokens("a".repeat(100), 10)).toBe(40)
    expect(clipEndByTokens("汉".repeat(100), 10)).toBe(10)
    expect(clipEndByTokens("abc", 10)).toBe(3)
  })

  it("parseFetchBlobArgs 与 isTextMime", () => {
    expect(parseFetchBlobArgs({ id: " b1 ", start: 0, end: 5 })).toEqual({ id: "b1", start: 0, end: 5 })
    expect(() => parseFetchBlobArgs({})).toThrow("`id`")
    expect(() => parseFetchBlobArgs({ id: "b", start: -1 })).toThrow("`start`")
    expect(() => parseFetchBlobArgs({ id: "b", end: 0 })).toThrow("`end`")
    expect(() => parseFetchBlobArgs({ id: "b", start: 2.5 })).toThrow("`start`")
    for (const m of [
      "text/plain; charset=utf-8",
      "application/json",
      "application/ld+json",
      "image/svg+xml",
    ]) {
      expect(isTextMime(m)).toBe(true)
    }
    for (const m of ["image/png", "application/octet-stream", "application/pdf"])
      expect(isTextMime(m)).toBe(false)
  })
})
