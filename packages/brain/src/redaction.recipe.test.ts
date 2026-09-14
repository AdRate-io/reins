/**
 * D5 脱敏配方（根 README "Redacting what reaches the log"）的可执行版本：README 里的两段代码就是下面的
 * `redactingTool` 与 `redactingLog`，这里用真循环证明它们各自管到哪、顺序错了会漏什么。
 *
 * - 服务端工具的结果在 `afterTool` 草稿上脱敏：草稿此时尚未 append，也还没被 spill 搬进 BlobStore
 * - 其它一切进日志的东西（用户消息、模型正文、宿主回填的客户端工具结果、脑子模块 emit 的事件）不经 afterTool，
 *   只能在 `EventLog.append` 上包一层
 */
import {
  type ContentPart,
  type CoreEvent,
  type CoreEventOf,
  defineTool,
  type Event,
  type EventLog,
  InMemoryBlobStore,
  InMemoryEventLog,
  type LoopConfig,
  type RunResult,
  runLoop,
  type Socket,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { spill } from "./spill/index.js"

// ---- 配方本体（与 README 逐字一致，改一处要同步另一处）----

/** 把文本里的秘密换成占位符；宿主自己定规则，这里以卡号与 token 为例 */
function redact(text: string): string {
  return text.replace(/\b\d{16}\b/g, "[card]").replace(/sk-[A-Za-z0-9]{8,}/g, "[token]")
}

const redactParts = (parts: ContentPart[]): ContentPart[] =>
  parts.map((p) => (p.type === "text" ? { ...p, text: redact(p.text) } : p))

/** 服务端工具结果：在草稿上脱敏。放在 sockets 最前面，spill / compact / pins 拿到的就已经是干净的 */
const redactingTool: Socket = {
  name: "redact",
  afterTool: (_ctx, _call, result) => ({
    ...result,
    payload: { ...result.payload, content: redactParts(result.payload.content) },
  }),
}

/** 其它事件：包住 append。只有写入被拦，read / tail / fork 原样透传——日志里从没有过原文 */
function redactingLog(log: EventLog): EventLog {
  const clean = (e: Event): Event => {
    const c = e as CoreEvent
    switch (c.type) {
      case "core.user_message":
      case "core.tool_result":
        return { ...c, payload: { ...c.payload, content: redactParts(c.payload.content) } } as Event
      case "core.model_text":
        return { ...c, payload: { ...c.payload, text: redact(c.payload.text) } } as Event
      default:
        return e
    }
  }
  return {
    append: (events) => log.append(events.map(clean)),
    read: (sessionId, opts) => log.read(sessionId, opts),
    tail: (sessionId, n) => log.tail(sessionId, n),
    fork: (from, at, to) => log.fork(from, at, to),
  }
}

// ---- 用例 ----

const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"
const CARD = "4111111111111111"
const TOKEN = "sk-abcdefghijklmnop"

const lookup = defineTool<{ q: string }>({
  name: "lookup",
  description: "查客户档案",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  // 结果故意超过 spill 的小上限，好看 blob 里存的是什么
  execute: ({ q }) => `${q} 的卡号 ${CARD}，密钥 ${TOKEN}\n${"filler line\n".repeat(400)}`,
})

const clientTool = defineTool<Record<string, never>>({
  name: "ask_browser",
  description: "客户端执行",
  inputSchema: { type: "object" },
  side: "client",
})

async function drain(gen: AsyncGenerator<Event, RunResult>, yielded: Event[] = []): Promise<RunResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
    yielded.push(step.value)
  }
}

async function all(log: EventLog): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(SESSION)) out.push(e as CoreEvent)
  return out
}

const textOf = (e: { payload: { content: ContentPart[] } }) =>
  e.payload.content.map((p) => (p.type === "text" ? p.text : "")).join("")

function config(
  sockets: Socket[],
  log: EventLog,
  blobs: InMemoryBlobStore,
  script: ScriptedLowering,
): LoopConfig {
  return {
    sessionId: SESSION,
    log,
    blobs,
    lowering: script,
    model: MODEL,
    tools: [lookup, clientTool],
    sockets,
  }
}

describe("D5 脱敏配方", () => {
  it("afterTool 在最前：工具结果进日志前已脱敏，spill 搬进 blob 的也是脱敏后的全文；用户消息与模型正文靠 append 包装", async () => {
    const raw = new InMemoryEventLog()
    const blobs = new InMemoryBlobStore()
    const script = new ScriptedLowering([
      { drafts: [callTool("c1", "lookup", { q: "客户甲" })] },
      { drafts: [say(`记下了，卡号是 ${CARD}`)] },
    ])
    const cfg = config([redactingTool, spill({ maxResultTokens: 200 })], redactingLog(raw), blobs, script)
    const yielded: Event[] = []
    const result = await drain(runLoop({ ...cfg, input: `帮我查客户甲，他的 token 是 ${TOKEN}` }), yielded)
    expect(result.status).toBe("done")

    const events = await all(raw)
    const dump = JSON.stringify(events)
    expect(dump).not.toContain(CARD)
    expect(dump).not.toContain(TOKEN)
    const user = events.find((e) => e.type === "core.user_message") as CoreEventOf<"core.user_message">
    expect(textOf(user)).toBe("帮我查客户甲，他的 token 是 [token]")
    const text = events.find((e) => e.type === "core.model_text") as CoreEventOf<"core.model_text">
    expect(text.payload.text).toBe("记下了，卡号是 [card]")
    // 模型看到的也是脱敏后的：循环每轮从日志重读时间线（宪法二），包装过的副本就是它的视图
    const seenByModel = script.requests[0]?.events.find((e) => e.type === "core.user_message") as
      | CoreEventOf<"core.user_message">
      | undefined
    expect(seenByModel && textOf(seenByModel)).toBe("帮我查客户甲，他的 token 是 [token]")
    // 边界：包装改不了循环 yield 出去的对象——`agent.run()` 的消费者、SSE 流、`onEvent` 拿到的是包装前的原文。
    // 流也要干净的话，在 input 进循环之前脱敏，或在编码器 / onEvent 里再洗一遍
    const streamed = yielded.find((e) => e.type === "core.user_message") as CoreEventOf<"core.user_message">
    expect(textOf(streamed)).toContain(TOKEN)
    // 工具结果没有这条边界：afterTool 改的就是那份草稿，yield 出去、进日志、给模型的是同一份
    const streamedResult = yielded.find(
      (e) => e.type === "core.tool_result",
    ) as CoreEventOf<"core.tool_result">
    expect(textOf(streamedResult)).not.toContain(CARD)

    // 结果超上限被 spill 外溢：blob 里的全文也是脱敏后的——因为 redactingTool 排在 spill 前面
    const toolResult = events.find((e) => e.type === "core.tool_result") as CoreEventOf<"core.tool_result">
    expect(toolResult.payload.spilled).toBeDefined()
    const blob = await blobs.get(toolResult.payload.spilled?.blobId ?? "")
    const full = new TextDecoder().decode(blob.bytes)
    expect(full).toContain("[card]")
    expect(full).not.toContain(CARD)
    expect(full).not.toContain(TOKEN)
  })

  it("顺序错了会漏：redactingTool 排在 spill 之后，日志干净但 blob 里是原文", async () => {
    const raw = new InMemoryEventLog()
    const blobs = new InMemoryBlobStore()
    const script = new ScriptedLowering([
      { drafts: [callTool("c1", "lookup", { q: "客户甲" })] },
      { drafts: [say("好")] },
    ])
    const cfg = config([spill({ maxResultTokens: 200 }), redactingTool], redactingLog(raw), blobs, script)
    await drain(runLoop({ ...cfg, input: "查" }))
    const events = await all(raw)
    expect(JSON.stringify(events)).not.toContain(CARD)
    const toolResult = events.find((e) => e.type === "core.tool_result") as CoreEventOf<"core.tool_result">
    const blob = await blobs.get(toolResult.payload.spilled?.blobId ?? "")
    expect(new TextDecoder().decode(blob.bytes)).toContain(CARD) // 漏了
  })

  it("宿主回填的客户端工具结果不经 afterTool，只有 append 包装拦得住", async () => {
    const raw = new InMemoryEventLog()
    const blobs = new InMemoryBlobStore()
    const script = new ScriptedLowering([
      { drafts: [callTool("c1", "ask_browser", {})] },
      { drafts: [say("收到")] },
    ])
    // 只装 afterTool 版脱敏、不包日志：先证明它管不到回填
    const bare = config([redactingTool], raw, blobs, script)
    const paused = await drain(runLoop({ ...bare, input: "问浏览器" }))
    expect(paused.status).toBe("paused")
    if (paused.status !== "paused") throw new Error("unreachable")
    const fill = {
      type: "core.tool_result" as const,
      actor: "tool" as const,
      payload: {
        toolCallId: "c1",
        name: "ask_browser",
        content: [{ type: "text" as const, text: `卡号 ${CARD}` }],
        isError: false,
      },
    }
    await drain(runLoop({ ...bare, resume: paused.state, input: fill }))
    expect(JSON.stringify(await all(raw))).toContain(CARD)

    // 同一场景换成包住日志：拦住
    const raw2 = new InMemoryEventLog()
    const script2 = new ScriptedLowering([
      { drafts: [callTool("c1", "ask_browser", {})] },
      { drafts: [say("收到")] },
    ])
    const wrapped = config([redactingTool], redactingLog(raw2), blobs, script2)
    const paused2 = await drain(runLoop({ ...wrapped, input: "问浏览器" }))
    if (paused2.status !== "paused") throw new Error("unreachable")
    const done = await drain(runLoop({ ...wrapped, resume: paused2.state, input: fill }))
    expect(done.status).toBe("done")
    const events = await all(raw2)
    expect(JSON.stringify(events)).not.toContain(CARD)
    const filled = events.find((e) => e.type === "core.tool_result") as CoreEventOf<"core.tool_result">
    expect(textOf(filled)).toBe("卡号 [card]")
  })
})
