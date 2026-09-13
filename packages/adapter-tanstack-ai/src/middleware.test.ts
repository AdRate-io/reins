/**
 * 真实 TanStack AI chat() 引擎 + 脚本化适配器 + reins 中间件的端到端用例。
 * 断言两件事：日志里记了什么（真源）、模型看到了什么（适配器收到的 providerMessages / systemPrompts / tools）。
 */
import {
  approval,
  budget,
  compact,
  handoff,
  inlineSkills,
  memory,
  perception,
  pins,
  skills,
  spill,
} from "@reins/brain"
import {
  type CoreEvent,
  type CoreEventOf,
  createCoreEvent,
  createCoreRegistry,
  type Event,
  InMemoryBlobStore,
  InMemoryEventLog,
  InMemoryMemoryStore,
  type Socket,
} from "@reins/core"
import {
  type AnyTool,
  chat,
  genericInterruptContinuationFromDescriptor,
  type Interrupt,
  type ModelMessage,
  maxIterations,
  type RunAgentResumeItem,
  type StreamChunk,
  toolDefinition,
  wrapGenericInterruptContinuation,
} from "@tanstack/ai"
import { describe, expect, it } from "vitest"
import { reinsApprovalInterrupt } from "./interrupt.js"
import { framedSystemNote } from "./messages.js"
import { type ReinsMiddlewareOptions, reinsMiddleware, TANSTACK_APPROVAL_POLICY } from "./middleware.js"
import { type AdapterScript, callTool, say, scriptedAdapter, think } from "./testing.js"

const SESSION = "s1"
const registry = createCoreRegistry()

function deterministic() {
  let t = 1_800_000_000_000
  let n = 0
  return { now: () => ++t, newId: () => `id${++n}` }
}

/** TanStack 宿主工具 */
const addTool = toolDefinition({
  name: "add",
  description: "两数相加",
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
}).server(async (args: unknown) => {
  const { a, b } = args as { a: number; b: number }
  return a + b
})

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of stream) out.push(c)
  return out
}

async function all(log: InMemoryEventLog, session = SESSION): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(session)) out.push(e as CoreEvent)
  return out
}
const types = (events: readonly Event[]) => events.map((e) => e.type.replace("core.", ""))
const textOf = (m: ModelMessage | undefined) =>
  typeof m?.content === "string" ? m.content : JSON.stringify(m?.content)

interface Fixture {
  log: InMemoryEventLog
  blobs: InMemoryBlobStore
  memoryStore: InMemoryMemoryStore
  adapter: ReturnType<typeof scriptedAdapter>
  events: Event[]
  run(input: {
    messages?: ModelMessage[]
    tools?: AnyTool[]
    systemPrompts?: string[]
    resume?: RunAgentResumeItem[]
    parentRunId?: string
    runId?: string
    /** 故意不登记 reinsApprovalInterrupt（R7 用例） */
    withoutInterrupts?: boolean
  }): Promise<StreamChunk[]>
}

function fixture(
  script: AdapterScript,
  sockets: readonly Socket[] = [],
  extra: Partial<ReinsMiddlewareOptions> = {},
  shared: Partial<Pick<Fixture, "log" | "blobs" | "memoryStore">> = {},
): Fixture {
  const log = shared.log ?? new InMemoryEventLog()
  const blobs = shared.blobs ?? new InMemoryBlobStore()
  const memoryStore = shared.memoryStore ?? new InMemoryMemoryStore()
  const adapter = scriptedAdapter(script)
  const events: Event[] = []
  const middleware = reinsMiddleware({
    sessionId: SESSION,
    log,
    blobs,
    memory: memoryStore,
    sockets,
    capabilities: { contextWindow: 100_000 },
    onEvent: (e) => events.push(e),
    warn: () => {},
    ...deterministic(),
    ...extra,
  })
  return {
    log,
    blobs,
    memoryStore,
    adapter,
    events,
    run: (input) =>
      drain(
        chat({
          adapter,
          messages: input.messages ?? [],
          tools: input.tools ?? [addTool],
          systemPrompts: input.systemPrompts ?? ["你是计算器"],
          middleware: [middleware],
          // 漏登记在类型层就会被 ReinsChatMiddleware 的第二个类型参数报出来，这里靠 unknown 绕过去只为测运行时那道闸
          ...(input.withoutInterrupts ? {} : { interrupts: [reinsApprovalInterrupt] }),
          agentLoopStrategy: maxIterations(10),
          threadId: "thread",
          debug: { errors: false },
          ...(input.resume ? { resume: input.resume } : {}),
          ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
        }) as AsyncIterable<StreamChunk>,
      ),
  }
}

const user = (text: string): ModelMessage => ({ role: "user", content: text })

describe("reinsMiddleware：基本流程", () => {
  it("用户消息进日志 → 模型调工具 → TanStack 执行 → 结果进日志 → 回答；模型每轮看到的是日志投影", async () => {
    const f = fixture([
      { blocks: [think("先算", "SIG"), callTool("c1", "add", { a: 2, b: 3 })] },
      { blocks: [say("答案是 5")] },
    ])
    await f.run({ messages: [user("算 2+3")] })

    const events = await all(f.log)
    // 每次请求 initRun 先落一条工具表快照 tools_bound（模型不可见），再导入客户端新消息
    expect(types(events)).toEqual([
      "tools_bound",
      "user_message",
      "model_thinking",
      "tool_call",
      "budget_usage",
      "tool_result",
      "model_text",
      "budget_usage",
    ])
    const result = events[5] as CoreEventOf<"core.tool_result">
    expect(result.payload).toEqual({
      toolCallId: "c1",
      name: "add",
      content: [{ type: "text", text: "5" }],
      isError: false,
    })
    expect(result.parentId).toBe(events[3]?.id)
    expect((events[2] as CoreEventOf<"core.model_thinking">).replay).toEqual({
      provider: "scripted",
      api: "tanstack-ai",
      model: "scripted-1",
      thinkingSignature: "SIG",
    })
    // 用量：promptTokens 100 → input 100；budget_usage 带投影估算
    const usage = events[4] as CoreEventOf<"core.budget_usage">
    expect(usage.payload.tokens).toEqual({ input: 100, output: 20 })
    expect(usage.payload.toolCalls).toBe(1)
    expect(usage.payload.contextEstimate).toBeGreaterThan(0)

    // 模型看到的：第一轮只有用户消息（tools_bound 模型不可见）；第二轮是日志投影（thinking 同源签名回放、工具结果）
    expect(f.adapter.calls).toHaveLength(2)
    expect(f.adapter.calls[0]?.messages).toEqual([{ role: "user", content: "算 2+3" }])
    expect(f.adapter.calls[1]?.messages).toEqual([
      { role: "user", content: "算 2+3" },
      {
        role: "assistant",
        content: null,
        thinking: [{ content: "先算", signature: "SIG" }],
        toolCalls: [{ id: "c1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } }],
      },
      // 工具输出 trust=untrusted，模型看到的是带 <untrusted> 标记的版本（§14）；日志里的事件仍是 "5"
      {
        role: "tool",
        toolCallId: "c1",
        name: "add",
        content: '<untrusted source="tool:add">\n5\n</untrusted>',
      },
    ])
    expect(f.adapter.calls[0]?.systemPrompts).toEqual(["你是计算器"])
    expect(f.adapter.calls[0]?.tools?.map((t) => t.name)).toEqual(["add"])
    // onEvent 拿到每一条
    expect(f.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it("第二次请求只导入末尾新用户消息，历史以日志为准", async () => {
    const f = fixture([{ blocks: [say("你好")] }, { blocks: [say("再见")] }])
    await f.run({ messages: [user("hi")] })
    // 客户端把整段历史（含它自己记的 assistant）连同新消息一起发来
    await f.run({ messages: [user("hi"), { role: "assistant", content: "你好" }, user("bye")] })
    // 两次请求各有一条 tools_bound 打头；两次工具表相同，所以不出工具变化说明
    expect(types(await all(f.log))).toEqual([
      "tools_bound",
      "user_message",
      "model_text",
      "budget_usage",
      "tools_bound",
      "user_message",
      "model_text",
      "budget_usage",
    ])
    expect(f.adapter.calls[1]?.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "你好" },
      { role: "user", content: "bye" },
    ])
  })

  it("日志为空而客户端带着历史：整段接管", async () => {
    const f = fixture([{ blocks: [say("继续")] }])
    await f.run({ messages: [user("a"), { role: "assistant", content: "b" }, user("c")] })
    const events = await all(f.log)
    expect(types(events).slice(0, 4)).toEqual(["tools_bound", "user_message", "model_text", "user_message"])
    // 幂等键 = 在客户端数组里的位置（R5）
    expect(events[2]?.provenance).toEqual({ source: "tanstack-ai", ref: "import:1" })
  })

  it("网络重试重发同一请求：末尾用户消息不入日志两次，模型接着日志里的历史走（R5）", async () => {
    const shared = { log: new InMemoryEventLog() }
    const warns: string[] = []
    const f = fixture([{ blocks: [say("你好")] }], [], { warn: (m) => warns.push(m) }, shared)
    await f.run({ messages: [user("hi")] })
    // 客户端没收到回复，把一模一样的请求再发一遍
    const f2 = fixture([{ blocks: [say("你好（重发）")] }], [], { warn: (m) => warns.push(m) }, shared)
    await f2.run({ messages: [user("hi")] })
    expect(types(await all(f.log))).toEqual([
      "tools_bound",
      "user_message",
      "model_text",
      "budget_usage",
      "tools_bound",
      "model_text",
      "budget_usage",
    ])
    expect(f2.adapter.calls[0]?.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "你好" },
    ])
    expect(warns).toEqual([expect.stringContaining("重发了 1 条")])
  })

  it("用户真的连说两遍同样的话：位置不同，照常入日志（R5 只挡同位置同内容）", async () => {
    const shared = { log: new InMemoryEventLog() }
    const f = fixture([{ blocks: [say("你好")] }], [], {}, shared)
    await f.run({ messages: [user("hi")] })
    const f2 = fixture([{ blocks: [say("又见")] }], [], {}, shared)
    await f2.run({ messages: [user("hi"), { role: "assistant", content: "你好" }, user("hi")] })
    const events = await all(f.log)
    expect(types(events).slice(4)).toEqual(["tools_bound", "user_message", "model_text", "budget_usage"])
    expect(events[5]?.provenance).toEqual({ source: "tanstack-ai", ref: "import:2" })
  })

  it("非正文事件以 CUSTOM chunk 推进流（name = 事件 type）", async () => {
    const f = fixture([{ blocks: [say("hi")] }], [perception()])
    const chunks = await f.run({ messages: [user("hi")] })
    const custom = chunks.filter((c) => c.type === "CUSTOM") as { name: string; value: { type: string } }[]
    // tools_bound 也是非正文事件，排在最前（initRun 里比感知说明更早落日志）
    expect(custom.map((c) => c.name)).toEqual(["core.tools_bound", "core.system_note", "core.budget_usage"])
    expect(custom[0]?.value.type).toBe("core.tools_bound")
    expect(custom[1]?.value.type).toBe("core.system_note")
  })

  it("日志里有读不出的事件：起步即拒绝，不写任何东西", async () => {
    const log = new InMemoryEventLog()
    await log.append([
      createCoreEvent(registry, {
        type: "core.user_message",
        actor: "user",
        payload: { content: [{ type: "text", text: "x" }] },
        sessionId: SESSION,
        seq: 1,
        at: 1,
        id: "a",
      }),
    ])
    const [first] = await all(log)
    if (!first) throw new Error("unreachable")
    await log.append([{ ...first, type: "ext.unknown", seq: 2, id: "b" } as Event])
    const f = fixture([{ blocks: [say("hi")] }], [], {}, { log })
    await expect(f.run({ messages: [user("hi")] })).rejects.toThrow()
    expect((await all(log)).length).toBe(2)
  })
})

describe("reinsMiddleware：脑子模块", () => {
  it("静态贡献：脑子工具与规则提示并入，整个 run 每轮逐字相同，宿主提示条目不动", async () => {
    const f = fixture(
      [
        { blocks: [callTool("c1", "add", { a: 1, b: 1 })] },
        { blocks: [callTool("c2", "add", { a: 1, b: 1 })] },
        { blocks: [say("ok")] },
      ],
      [compact(), pins()],
    )
    await f.run({ messages: [user("go")] })
    expect(f.adapter.calls).toHaveLength(3)
    const names = f.adapter.calls[0]?.tools?.map((t) => t.name)
    expect(names).toEqual(["add", "compact", "recall", "pin"])
    const prompts0 = f.adapter.calls[0]?.systemPrompts
    expect(prompts0?.[0]).toBe("你是计算器")
    expect(prompts0).toHaveLength(2)
    for (const c of f.adapter.calls) {
      expect(c.systemPrompts).toEqual(prompts0)
      expect(c.tools?.map((t) => t.name)).toEqual(names)
    }
  })

  it("perception：感知说明注入当轮即可见，落成 <system_note> 标签走 user", async () => {
    const f = fixture(
      [{ blocks: [callTool("c1", "add", { a: 1, b: 1 })] }, { blocks: [say("ok")] }],
      [perception()],
    )
    await f.run({ messages: [user("go")] })
    const events = await all(f.log)
    expect(types(events).slice(0, 4)).toEqual(["tools_bound", "user_message", "system_note", "tool_call"])
    const note = events[2] as CoreEventOf<"core.system_note">
    expect(note.payload.kind).toBe("perception")
    const first = f.adapter.calls[0]?.messages
    expect(first?.[1]).toEqual({ role: "user", content: framedSystemNote("perception", note.payload.text) })
  })

  it("pins：模型 pin 工具经 TanStack 执行，留痕排在结果前，下一轮可见", async () => {
    const f = fixture(
      [{ blocks: [callTool("c1", "pin", { text: "总重 30kg" })] }, { blocks: [say("记住了")] }],
      [pins()],
    )
    await f.run({ messages: [user("记住总重 30kg")] })
    const events = await all(f.log)
    expect(types(events)).toEqual([
      "tools_bound",
      "user_message",
      "tool_call",
      "budget_usage",
      "system_note",
      "tool_result",
      "model_text",
      "budget_usage",
    ])
    const pin = events[4] as CoreEventOf<"core.system_note">
    expect(pin.payload).toMatchObject({ kind: "pin", text: "总重 30kg" })
    expect(pin.actor).toBe("model")
    expect(pin.parentId).toBe(events[2]?.id)
    expect(textOf(f.adapter.calls[1]?.messages?.[3])).toContain("总重 30kg")
  })

  it("memory：ToolContext 带 toolCallId 与 MemoryStore，memory_op 留痕引用调用 id", async () => {
    const f = fixture(
      [
        {
          blocks: [
            callTool("c1", "memory", { command: "create", path: "/memories/a.md", file_text: "hello" }),
          ],
        },
        { blocks: [say("存了")] },
      ],
      [memory()],
    )
    await f.run({ messages: [user("存一下")] })
    const events = await all(f.log)
    expect(types(events)).toEqual([
      "tools_bound",
      "user_message",
      "tool_call",
      "budget_usage",
      "memory_op",
      "tool_result",
      "model_text",
      "budget_usage",
    ])
    const op = events[4] as CoreEventOf<"core.memory_op">
    expect(op.payload).toMatchObject({ op: "create", path: "/memories/a.md" })
    expect(op.provenance?.ref).toBe("c1")
    expect((events[5] as CoreEventOf<"core.tool_result">).payload.isError).toBe(false)
  })

  it("skills：菜单进系统提示，skill_read 的结果 trust=system、模型看到的不套 <untrusted>（与 runLoop 同一口径的 resultTrust）", async () => {
    const source = inlineSkills({
      ads: "---\nname: ads\ndescription: Change campaigns safely.\n---\n\nAlways read fresh state first.\n",
    })
    const f = fixture(
      [{ blocks: [callTool("c1", "skill_read", { name: "ads" })] }, { blocks: [say("读完了")] }],
      [skills({ source, warn: () => {} })],
    )
    await f.run({ messages: [user("停投一条")] })
    const events = await all(f.log)
    expect(types(events)).toEqual([
      "tools_bound",
      "user_message",
      "tool_call",
      "budget_usage",
      "tool_result",
      "model_text",
      "budget_usage",
    ])
    const result = events[4] as CoreEventOf<"core.tool_result">
    expect(result.trust).toBe("system")
    expect(result.payload.isError).toBe(false)
    expect(f.adapter.calls[0]?.systemPrompts?.join("\n")).toContain(
      "Available skills:\n- ads: Change campaigns safely.",
    )
    const toolMessage = f.adapter.calls[1]?.messages?.[2]
    expect(toolMessage).toMatchObject({ role: "tool", toolCallId: "c1", name: "skill_read" })
    expect(textOf(toolMessage)).toContain("Always read fresh state first.")
    expect(textOf(toolMessage)).not.toContain("<untrusted")
  })

  it("spill：宿主工具的大结果外溢，模型下一轮看到预览；fetch_blob 能取回", async () => {
    const big = toolDefinition({
      name: "dump",
      description: "吐大量文本",
      inputSchema: { type: "object", properties: {} },
    }).server(async () => Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"))
    // fetch_blob 的 id 要用真实 blobId：函数剧本按日志现取
    let blobId = ""
    const f2 = fixture(
      (_opts, call) => {
        if (call === 0) return { blocks: [callTool("c1", "dump", {})] }
        if (call === 1) return { blocks: [callTool("c2", "fetch_blob", { id: blobId, start: 0, end: 40 })] }
        return { blocks: [say("done")] }
      },
      [spill({ maxResultTokens: 100, previewLines: 2 })],
      {
        onEvent: (e) => {
          if (e.type === "core.tool_result") {
            const spilled = (e as CoreEventOf<"core.tool_result">).payload.spilled
            if (spilled) blobId = spilled.blobId
          }
        },
      },
    )
    await f2.run({ messages: [user("dump")], tools: [big] })
    const events = await all(f2.log)
    const first = events.find((e) => e.type === "core.tool_result") as CoreEventOf<"core.tool_result">
    expect(first.payload.spilled?.blobId).toBe(blobId)
    expect(blobId).not.toBe("")
    const seenByModel = textOf(f2.adapter.calls[1]?.messages?.[2])
    expect(seenByModel).toContain("line 0")
    expect(seenByModel).not.toContain("line 100")
    const fetched = events.filter((e) => e.type === "core.tool_result")[1] as CoreEventOf<"core.tool_result">
    expect(fetched.payload.isError).toBe(false)
    expect(fetched.payload.content[0]).toMatchObject({ type: "text" })
    expect((fetched.payload.content[0] as { text: string }).text).toContain("line 0")
  })

  it("beforeTool：rewrite 改写入参后 TanStack 按新入参执行；block 变成错误结果且不执行", async () => {
    let executed = 0
    const counting = toolDefinition({
      name: "add",
      description: "两数相加",
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
    }).server(async (args: unknown) => {
      executed++
      const { a, b } = args as { a: number; b: number }
      return a + b
    })
    const socket: Socket = {
      name: "test",
      beforeTool(_ctx, call) {
        const args = call.payload.args as { a: number; b: number }
        if (args.a === 1) return { rewrite: { a: 10, b: 10 } }
        if (args.a === 2) return { block: "不许" }
        return undefined
      },
    }
    const f = fixture(
      [
        { blocks: [callTool("c1", "add", { a: 1, b: 1 }), callTool("c2", "add", { a: 2, b: 2 })] },
        { blocks: [say("ok")] },
      ],
      [socket],
    )
    await f.run({ messages: [user("go")], tools: [counting] })
    const results = (await all(f.log)).filter(
      (e) => e.type === "core.tool_result",
    ) as CoreEventOf<"core.tool_result">[]
    expect(results.map((r) => r.payload.content[0])).toEqual([
      { type: "text", text: "20" },
      { type: "text", text: "工具调用被拦截：不许" },
    ])
    expect(results[1]?.payload.isError).toBe(true)
    expect(executed).toBe(1)
  })

  it("budget：工具调用触顶且模型还要继续 → run 停下并记 run_paused(budget)", async () => {
    const f = fixture(
      [
        { blocks: [callTool("c1", "add", { a: 1, b: 1 })] },
        { blocks: [callTool("c2", "add", { a: 1, b: 1 })] },
        { blocks: [say("never")] },
      ],
      [budget({ limits: { toolCalls: 1 } })],
    )
    await f.run({ messages: [user("go")] })
    const events = await all(f.log)
    expect(types(events).at(-1)).toBe("run_paused")
    expect((events.at(-1) as CoreEventOf<"core.run_paused">).payload.reason).toBe("budget")
    expect(f.adapter.calls).toHaveLength(1)
  })

  it("handoff：交接记录 + 新会话开头 + onHandoff，run 停下", async () => {
    const handoffs: [string, string][] = []
    const f = fixture(
      [
        {
          blocks: [
            callTool("c1", "handoff", { summary: "聊到一半", nextSteps: ["继续"], triggerMessage: "接着" }),
          ],
        },
        { blocks: [say("never")] },
      ],
      [handoff()],
      { onHandoff: (a, b) => void handoffs.push([a, b]) },
    )
    await f.run({ messages: [user("交接")] })
    const events = await all(f.log)
    expect(types(events).at(-1)).toBe("handoff")
    expect(handoffs).toHaveLength(1)
    const to = handoffs[0]?.[1] ?? ""
    const opened = await all(f.log, to)
    expect(types(opened)).toEqual(["system_note", "user_message"])
    expect(f.adapter.calls).toHaveLength(1)
  })
})

describe("reinsMiddleware：审批", () => {
  const deployTool = toolDefinition({
    name: "deploy",
    description: "上线",
    inputSchema: { type: "object", properties: { env: { type: "string" } } },
  }).server(async () => "deployed")

  function interruptOf(chunks: StreamChunk[]): { interrupt: Interrupt; runId: string } {
    const finished = chunks.find(
      (c) => c.type === "RUN_FINISHED" && (c as { outcome?: { type: string } }).outcome?.type === "interrupt",
    ) as { runId: string; outcome: { interrupts: Interrupt[] } } | undefined
    expect(finished).toBeDefined()
    const interrupt = finished?.outcome.interrupts[0]
    if (!finished || !interrupt) throw new Error("unreachable")
    return { interrupt, runId: finished.runId }
  }

  function resumeItem(interrupt: Interrupt, response: unknown): RunAgentResumeItem {
    const continuation = genericInterruptContinuationFromDescriptor(interrupt)
    if (!continuation) throw new Error("不是通用中断")
    return {
      interruptId: interrupt.id,
      status: "resolved",
      payload: response,
      metadata: wrapGenericInterruptContinuation(continuation),
    }
  }

  const history = (): ModelMessage[] => [
    user("上线"),
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "c1", type: "function", function: { name: "deploy", arguments: '{"env":"prod"}' } }],
    },
  ]

  it("approval 模块 ask → 通用中断暂停：日志 approval_request + run_paused，工具未执行；批准后续跑执行", async () => {
    const shared = { log: new InMemoryEventLog() }
    const sockets = [approval({ ask: ["deploy"] })]
    const f = fixture([{ blocks: [callTool("c1", "deploy", { env: "prod" })] }], sockets, {}, shared)
    const chunks = await f.run({ messages: [user("上线")], tools: [deployTool], runId: "run1" })
    let events = await all(f.log)
    expect(types(events)).toEqual([
      "tools_bound",
      "user_message",
      "tool_call",
      "budget_usage",
      "approval_request",
      "run_paused",
    ])
    const req = events[4] as CoreEventOf<"core.approval_request">
    expect(req.payload).toMatchObject({ toolCallId: "c1", summary: expect.stringContaining("deploy") })
    const { interrupt, runId } = interruptOf(chunks)
    expect(interrupt.metadata?.["tanstack:interruptPayload"] ?? interrupt.metadata).toBeDefined()

    // 续跑：客户端带着历史、parentRunId 与答复回来
    const f2 = fixture([{ blocks: [say("上线完成")] }], sockets, {}, shared)
    await f2.run({
      messages: history(),
      tools: [deployTool],
      parentRunId: runId,
      resume: [resumeItem(interrupt, { approved: true, by: "boss" })],
    })
    events = await all(f.log)
    // 续跑也是一次新请求：先落第二条 tools_bound（工具表未变，不出说明），再是审批答复
    expect(types(events).slice(6)).toEqual([
      "tools_bound",
      "approval_decision",
      "run_resumed",
      "tool_result",
      "model_text",
      "budget_usage",
    ])
    const decision = events[7] as CoreEventOf<"core.approval_decision">
    expect(decision.payload).toEqual({ toolCallId: "c1", approved: true, by: "boss" })
    const result = events[9] as CoreEventOf<"core.tool_result">
    expect(result.payload).toMatchObject({ isError: false, content: [{ type: "text", text: "deployed" }] })
    // 续跑那次模型看到的仍是日志投影：用户 → 工具调用 → 结果
    expect(f2.adapter.calls[0]?.messages?.map((m) => m.role)).toEqual(["user", "assistant", "tool"])
  })

  it("拒绝：approval_decision(false) + 结果记为审批被拒绝，工具未执行", async () => {
    const shared = { log: new InMemoryEventLog() }
    const sockets = [approval({ ask: ["deploy"] })]
    let executed = 0
    const counting = toolDefinition({
      name: "deploy",
      description: "上线",
      inputSchema: { type: "object", properties: {} },
    }).server(async () => {
      executed++
      return "deployed"
    })
    const f = fixture([{ blocks: [callTool("c1", "deploy", { env: "prod" })] }], sockets, {}, shared)
    const chunks = await f.run({ messages: [user("上线")], tools: [counting], runId: "run1" })
    const { interrupt, runId } = interruptOf(chunks)
    const f2 = fixture([{ blocks: [say("不上了")] }], sockets, {}, shared)
    await f2.run({
      messages: history(),
      tools: [counting],
      parentRunId: runId,
      resume: [resumeItem(interrupt, { approved: false, reason: "太晚了" })],
    })
    const events = await all(f.log)
    const decision = events.find(
      (e) => e.type === "core.approval_decision",
    ) as CoreEventOf<"core.approval_decision">
    expect(decision.payload).toEqual({ toolCallId: "c1", approved: false, by: "tanstack", reason: "太晚了" })
    const result = events.find((e) => e.type === "core.tool_result") as CoreEventOf<"core.tool_result">
    expect(result.payload.isError).toBe(true)
    expect((result.payload.content[0] as { text: string }).text).toContain("审批被拒绝：太晚了")
    expect(executed).toBe(0)
  })

  it("TanStack 原生 needsApproval 工具：审批请求以 tanstack.needsApproval 入日志并暂停", async () => {
    const native = toolDefinition({
      name: "deploy",
      description: "上线",
      inputSchema: { type: "object", properties: {} },
      needsApproval: true,
    }).server(async () => "deployed")
    const f = fixture([{ blocks: [callTool("c1", "deploy", {})] }])
    await f.run({ messages: [user("上线")], tools: [native] })
    const events = await all(f.log)
    expect(types(events)).toEqual([
      "tools_bound",
      "user_message",
      "tool_call",
      "budget_usage",
      "approval_request",
      "run_paused",
    ])
    expect((events[4] as CoreEventOf<"core.approval_request">).payload.policyId).toBe(
      TANSTACK_APPROVAL_POLICY,
    )
  })

  it("宿主漏登记 reinsApprovalInterrupt：init 告警一次，需审批的调用降级为拒绝且留痕，工具未执行（R7 fail-closed）", async () => {
    const warns: string[] = []
    const f = fixture(
      [{ blocks: [callTool("c1", "deploy", { env: "prod" })] }, { blocks: [say("没人能批")] }],
      [approval({ ask: ["deploy"] })],
      { warn: (m) => warns.push(m) },
    )
    await f.run({ messages: [user("上线")], tools: [deployTool], withoutInterrupts: true })
    expect(warns).toEqual([expect.stringContaining("未登记")])
    const events = await all(f.log)
    expect(types(events)).toEqual([
      "tools_bound",
      "user_message",
      "tool_call",
      "budget_usage",
      "approval_request",
      "approval_decision",
      "tool_result",
      "model_text",
      "budget_usage",
    ])
    expect((events[5] as CoreEventOf<"core.approval_decision">).payload).toEqual({
      toolCallId: "c1",
      approved: false,
      by: "reins",
      reason: expect.stringContaining("未登记"),
    })
    const result = events[6] as CoreEventOf<"core.tool_result">
    expect(result.payload.isError).toBe(true)
    expect((result.payload.content[0] as { text: string }).text).toContain("审批被拒绝")
    // 没有 run_paused，也没有引擎抛错：run 正常跑完，模型在下一轮看到拒绝结果
    expect(f.adapter.calls[1]?.messages?.[2]).toMatchObject({
      role: "tool",
      error: expect.stringContaining("审批被拒绝"),
    })
  })

  it("approval 模块 deny：留痕 approval_decision 后拦截，模型看到错误结果", async () => {
    const f = fixture(
      [{ blocks: [callTool("c1", "deploy", { env: "prod" })] }, { blocks: [say("被拒了")] }],
      [approval({ deny: ["deploy"] })],
    )
    await f.run({ messages: [user("上线")], tools: [deployTool] })
    const events = await all(f.log)
    expect(types(events)).toEqual([
      "tools_bound",
      "user_message",
      "tool_call",
      "budget_usage",
      "approval_decision",
      "tool_result",
      "model_text",
      "budget_usage",
    ])
    expect((events[5] as CoreEventOf<"core.tool_result">).payload.isError).toBe(true)
    expect(f.adapter.calls[1]?.messages?.[2]).toMatchObject({
      role: "tool",
      error: expect.stringContaining("拦截"),
    })
  })
})
