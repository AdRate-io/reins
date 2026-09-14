/**
 * mcpTools × runLoop：走真实 MCP 协议（内存传输）的端到端用例。
 * 机制正确性用 ScriptedLowering 验（模型说什么由剧本定），真模型行为在 examples/mcp 里跑。
 */

import { approval, spill } from "@reinsjs/brain"
import {
  type CoreEvent,
  type CoreEventOf,
  type Event,
  InMemoryBlobStore,
  InMemoryEventLog,
  type LoopConfig,
  type RunResult,
  RunStateError,
  runLoop,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, type ScriptedTurn, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { mcpTools } from "./mcp-tools.js"
import { fixtureServer } from "./test-utils.js"
import { McpToolsError, type McpTransport } from "./types.js"

const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"

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

async function all(log: InMemoryEventLog, sessionId = SESSION): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(sessionId)) out.push(e as CoreEvent)
  return out
}

const types = (events: readonly Event[]) => events.map((e) => e.type.replace("core.", ""))
const results = (events: readonly CoreEvent[]) =>
  events.filter((e): e is CoreEventOf<"core.tool_result"> => e.type === "core.tool_result")
const textOf = (r: CoreEventOf<"core.tool_result">) =>
  r.payload.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("")

function cfg(lowering: ScriptedLowering, log: InMemoryEventLog, extra: Partial<LoopConfig> = {}): LoopConfig {
  return { sessionId: SESSION, log, lowering, model: MODEL, ...deterministic(), ...extra }
}

describe("mcpTools：run 起步 tools/list → reins Tool", () => {
  it("四个工具的名字、说明、schema 原样透传；注解定 risk 与 needsApproval 缺省；连接懒建且跨 run 复用", async () => {
    const fx = fixtureServer()
    const socket = mcpTools({ transport: fx.transport })
    expect(fx.connects).toBe(0) // 构造不连接
    expect(socket.name).toBe("mcp:memory")

    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [say("hi")] }])
    await drain(runLoop(cfg(lowering, log, { sockets: [socket] })))
    expect(fx.connects).toBe(1)

    const tools = lowering.requests[0]?.tools ?? []
    expect(tools.map((t) => t.name)).toEqual(["echo", "drop_table", "flaky", "big"])
    expect(tools[0]?.description).toBe("Echo the text back")
    expect(tools[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    })

    // 风险档与审批缺省要看 Tool 本身（ToolSpec 里没有），从 tools_bound 之外再解析一次
    const resolved = await (socket.tools as (s: never) => Promise<readonly import("@reinsjs/core").Tool[]>)(
      undefined as never,
    )
    const byName = new Map(resolved.map((t) => [t.name, t]))
    expect(byName.get("echo")?.risk).toBe("low")
    expect(byName.get("echo")?.needsApproval).toBeUndefined()
    expect(byName.get("drop_table")?.risk).toBe("high")
    expect(byName.get("drop_table")?.needsApproval).toBe(true)
    expect(byName.get("flaky")?.risk).toBe("medium")

    // tools_bound 快照记下了这次 run 的工具表
    const logged = await all(log)
    const bound = logged[0] as CoreEventOf<"core.tools_bound">
    expect(bound.type).toBe("core.tools_bound")
    expect(bound.payload.toolNames).toEqual(["big", "drop_table", "echo", "flaky"])

    // 第二次 run 复用同一条连接
    await drain(runLoop(cfg(new ScriptedLowering([{ drafts: [say("again")] }]), log, { sockets: [socket] })))
    expect(fx.connects).toBe(1)
    await socket.close()
  })

  it("prefix 加在模型侧名字上、调用时用原名；非法字符改写并告警一次；override 可改字段或用 false 排除", async () => {
    const fx = fixtureServer()
    fx.server.registerTool(
      "files.read",
      { description: "read", inputSchema: { path: z.string() } },
      async ({ path }) => ({
        content: [{ type: "text" as const, text: `read ${path}` }],
      }),
    )
    const warnings: string[] = []
    const socket = mcpTools({
      transport: fx.transport,
      prefix: "fs_",
      warn: (m) => warnings.push(m),
      override: (tool, info) => {
        if (info.name === "flaky") return false
        if (info.name === "drop_table") return { ...tool, needsApproval: false }
        return undefined
      },
    })
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      {
        drafts: [
          callTool("c1", "fs_files_read", { path: "/a" }),
          callTool("c2", "fs_drop_table", { table: "t" }),
        ],
      },
      { drafts: [say("done")] },
    ])
    const { result } = await drain(runLoop(cfg(lowering, log, { sockets: [socket] })))
    expect(result.status).toBe("done") // drop_table 的审批被 override 关掉了，不暂停
    expect((lowering.requests[0]?.tools ?? []).map((t) => t.name)).toEqual([
      "fs_echo",
      "fs_drop_table",
      "fs_big",
      "fs_files_read",
    ])
    expect(results(await all(log)).map(textOf)).toEqual(["read /a", "dropped t"])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("files.read")
    await socket.close()
  })
})

describe("mcpTools：tools/call 的结果与失败", () => {
  it("正常结果 → tool_result 文本；服务器 isError 直通；服务器已删掉的工具 → 抛错记成 isError，循环不崩", async () => {
    const fx = fixtureServer()
    const temp = fx.server.registerTool("temp", { description: "temporary", inputSchema: {} }, async () => ({
      content: [{ type: "text" as const, text: "temp ok" }],
    }))
    const socket = mcpTools({ transport: fx.transport })
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering((_input, turn): ScriptedTurn => {
      if (turn === 0) {
        // 工具表已按起步时的 list 定下来；现在服务器把 temp 删了，模型按记忆调它
        temp.remove()
        return {
          drafts: [
            callTool("c1", "echo", { text: "hi" }),
            callTool("c2", "flaky", { fail: true }),
            callTool("c3", "temp", {}),
          ],
        }
      }
      return { drafts: [say("done")] }
    })
    const { result } = await drain(runLoop(cfg(lowering, log, { sockets: [socket] })))
    expect(result.status).toBe("done")
    const rs = results(await all(log))
    expect(rs.map((r) => [r.payload.isError, textOf(r)])).toEqual([
      [false, "echo:hi"],
      [true, "server says: failed on purpose"],
      [true, expect.stringContaining("工具执行失败")],
    ])
    expect(textOf(rs[2] as CoreEventOf<"core.tool_result">)).toMatch(/temp.*not found/i)
    await socket.close()
  })

  it("多态内容：图片块成 image 片段，其余按翻译规则", async () => {
    const fx = fixtureServer()
    fx.server.registerTool("shot", { description: "screenshot", inputSchema: {} }, async () => ({
      content: [
        { type: "text" as const, text: "here" },
        { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" },
        { type: "resource_link" as const, uri: "file:///r.txt", name: "r.txt" },
      ],
    }))
    const socket = mcpTools({ transport: fx.transport })
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [callTool("c1", "shot", {})] }, { drafts: [say("ok")] }])
    await drain(runLoop(cfg(lowering, log, { sockets: [socket] })))
    const [r] = results(await all(log))
    expect(r?.payload.content).toEqual([
      { type: "text", text: "here" },
      { type: "image", mime: "image/png", data: "aGVsbG8=" },
      { type: "text", text: "Resource link: file:///r.txt (r.txt)" },
    ])
    await socket.close()
  })

  it("服务器中途死掉：本次调用 isError、run 照常收尾；服务器回来后下一次需要时按配方重建连接", async () => {
    const fx = fixtureServer()
    const socket = mcpTools({ transport: fx.transport })
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering((_input, turn): ScriptedTurn => {
      if (turn === 0) {
        // 起步已经 list 过了；现在服务器进程没了：连接断开（内存传输的 close 同步通知对端），且重连也连不上
        fx.down = true
        void fx.serverTransports[0]?.close()
        return { drafts: [callTool("c1", "echo", { text: "hi" })] }
      }
      return { drafts: [say("done")] }
    })
    const { result } = await drain(runLoop(cfg(lowering, log, { sockets: [socket] })))
    expect(result.status).toBe("done")
    const [r] = results(await all(log))
    expect(r?.payload.isError).toBe(true)
    expect(textOf(r as CoreEventOf<"core.tool_result">)).toContain("工具执行失败")
    expect(textOf(r as CoreEventOf<"core.tool_result">)).toContain("ECONNREFUSED")
    expect(fx.connects).toBe(1)

    // 服务器回来了：下一次 run 起步 list 时发现连接没了 → 重建一条，工具照常可用
    fx.down = false
    const second = new ScriptedLowering([
      { drafts: [callTool("c2", "echo", { text: "back" })] },
      { drafts: [say("ok")] },
    ])
    await drain(runLoop(cfg(second, log, { sockets: [socket] })))
    expect(fx.connects).toBe(2)
    const rs = results(await all(log))
    expect(textOf(rs[1] as CoreEventOf<"core.tool_result">)).toBe("echo:back")
    await socket.close()
    expect(fx.connects).toBe(2)
  })

  it("连接只是断了、服务器还在：下一次调用（同一 run 内也算）按配方重建一次，模型无感", async () => {
    const fx = fixtureServer()
    const socket = mcpTools({ transport: fx.transport })
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering((_input, turn): ScriptedTurn => {
      if (turn === 0) {
        void fx.serverTransports[0]?.close()
        return { drafts: [callTool("c1", "echo", { text: "hi" })] }
      }
      return { drafts: [say("done")] }
    })
    await drain(runLoop(cfg(lowering, log, { sockets: [socket] })))
    const [r] = results(await all(log))
    expect(r?.payload.isError).toBe(false)
    expect(textOf(r as CoreEventOf<"core.tool_result">)).toBe("echo:hi")
    expect(fx.connects).toBe(2)
    await socket.close()
  })
})

describe("mcpTools：工具表按 run 绑定", () => {
  it("run 中服务器加了工具（listChanged）：本 run 后续轮的工具表不变；下一次 run 才有，且模型收到增删说明", async () => {
    const fx = fixtureServer()
    const socket = mcpTools({ transport: fx.transport })
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering((input, turn): ScriptedTurn => {
      if (turn === 0) {
        fx.server.registerTool("late", { description: "added mid-run", inputSchema: {} }, async () => ({
          content: [{ type: "text" as const, text: "late" }],
        }))
        return { drafts: [callTool("c1", "echo", { text: "x" })] }
      }
      // 第二轮：服务器已发过 listChanged，但工具表仍是起步时那份
      expect((input.tools ?? []).map((t) => t.name)).not.toContain("late")
      return { drafts: [say("done")] }
    })
    await drain(runLoop(cfg(lowering, log, { sockets: [socket] })))
    expect(lowering.requests).toHaveLength(2)

    const second = new ScriptedLowering([{ drafts: [say("second")] }])
    const { events } = await drain(runLoop(cfg(second, log, { sockets: [socket] })))
    expect(types(events).slice(0, 2)).toEqual(["tools_bound", "system_note"])
    const note = events[1] as CoreEventOf<"core.system_note">
    expect(note.payload.kind).toBe("host")
    expect(note.payload.text).toBe("Your available tools changed since the previous run. Added: late.")
    expect(note.payload.meta).toEqual({ toolsChanged: { added: ["late"], removed: [] } })
    expect((second.requests[0]?.tools ?? []).map((t) => t.name)).toContain("late")
    // 说明是模型可见的：进了这一轮的视图
    expect(second.requests[0]?.events.some((e) => e.id === note.id)).toBe(true)
    await socket.close()
  })

  it("暂停等审批期间服务器换了工具表：带 state 续跑被判 config_mismatch；allowConfigDrift 放行且照样出增删说明", async () => {
    const fx = fixtureServer()
    const socket = mcpTools({ transport: fx.transport })
    const log = new InMemoryEventLog()
    const first = await drain(
      runLoop(
        cfg(new ScriptedLowering([{ drafts: [callTool("c1", "drop_table", { table: "users" })] }]), log, {
          sockets: [socket],
          secret: "k",
        }),
      ),
    )
    expect(first.result.status).toBe("paused")
    if (first.result.status !== "paused") throw new Error("unreachable")
    const state = first.result.state
    const decisions = [{ toolCallId: "c1", approved: true, by: "boss" }]

    // 暂停期间服务器加了一个工具 → 工具表（configHash）变了
    fx.server.registerTool("late", { description: "late", inputSchema: {} }, async () => ({ content: [] }))

    const resume = (extra: Partial<LoopConfig>) =>
      drain(
        runLoop(
          cfg(new ScriptedLowering([{ drafts: [say("done")] }]), log, {
            sockets: [socket],
            secret: "k",
            resume: state,
            decisions,
            ...extra,
          }),
        ),
      )
    await expect(resume({})).rejects.toMatchObject({ name: "RunStateError", code: "config_mismatch" })
    // 拒绝发生在写任何日志之前
    expect(types(await all(log)).at(-1)).toBe("run_paused")

    const { events, result } = await resume({ allowConfigDrift: true })
    expect(result.status).toBe("done")
    expect(types(events).slice(0, 5)).toEqual([
      "run_resumed",
      "approval_decision",
      "tools_bound",
      "system_note",
      "tool_result",
    ])
    expect((events[3] as CoreEventOf<"core.system_note">).payload.text).toContain("Added: late")
    expect(textOf(events[4] as CoreEventOf<"core.tool_result">)).toBe("dropped users")
    await socket.close()
  })
})

describe("mcpTools × spill × approval：同装时自动生效，服务器不需要知道 reins", () => {
  it("超长结果外溢进 BlobStore；destructiveHint 工具按 approval 的 byRisk 缺省停下等审批", async () => {
    const fx = fixtureServer()
    const socket = mcpTools({ transport: fx.transport })
    const log = new InMemoryEventLog()
    const blobs = new InMemoryBlobStore()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "big", { lines: 400 })] },
      { drafts: [callTool("c2", "drop_table", { table: "t" })] },
    ])
    const { result } = await drain(
      runLoop(
        cfg(lowering, log, {
          blobs,
          // big 没有注解 → medium → approval 缺省会问人；这里放行它，只看 drop_table 被拦
          sockets: [socket, spill({ maxResultTokens: 500 }), approval({ allow: ["big"], warn: () => {} })],
        }),
      ),
    )
    expect(result.status).toBe("paused")
    if (result.status !== "paused") throw new Error("unreachable")
    expect(result.reason).toBe("approval")
    expect(result.interruptions[0]).toMatchObject({ kind: "approval", toolCallId: "c2" })
    // approval 模块把工具自己声明的 needsApproval 当 ask 段最后一条规则，policyId 沿用循环内置那个名字
    expect((result.interruptions[0] as { request: { policyId: string } }).request.policyId).toBe(
      "tool.needsApproval",
    )
    expect(types(await all(log))).toContain("approval_request")

    const [big] = results(await all(log))
    expect(big?.payload.spilled?.blobId).toBeDefined()
    expect(textOf(big as CoreEventOf<"core.tool_result">)).toContain("line 1:")
    expect(textOf(big as CoreEventOf<"core.tool_result">)).not.toContain("line 200:")
    await socket.close()
  })
})

describe("mcpTools：起步连不上", () => {
  const broken: McpTransport = {
    kind: "custom",
    label: "broken",
    create: () => {
      throw new Error("no server here")
    },
  }

  it("缺省 fail-closed：runLoop 抛 McpToolsError，一条日志都不写", async () => {
    const log = new InMemoryEventLog()
    const socket = mcpTools({ transport: broken })
    await expect(
      drain(runLoop(cfg(new ScriptedLowering([{ drafts: [say("x")] }]), log, { sockets: [socket] }))),
    ).rejects.toBeInstanceOf(McpToolsError)
    expect(await all(log)).toEqual([])
  })

  it("optional：本次 run 不带它的工具、告警一次；模型从工具变化说明看到它们没了", async () => {
    // 先用正常服务器跑一次，让日志里有一份含 MCP 工具的 tools_bound
    const fx = fixtureServer()
    const log = new InMemoryEventLog()
    const good = mcpTools({ transport: fx.transport })
    await drain(runLoop(cfg(new ScriptedLowering([{ drafts: [say("x")] }]), log, { sockets: [good] })))
    await good.close()

    const warnings: string[] = []
    const socket = mcpTools({ transport: broken, optional: true, warn: (m) => warnings.push(m) })
    const lowering = new ScriptedLowering([{ drafts: [say("y")] }])
    const { events, result } = await drain(runLoop(cfg(lowering, log, { sockets: [socket] })))
    expect(result.status).toBe("done")
    expect(lowering.requests[0]?.tools).toEqual([])
    expect(warnings).toHaveLength(1)
    expect((events[1] as CoreEventOf<"core.system_note">).payload.text).toContain(
      "Removed (no longer callable, even if earlier turns used them): big, drop_table, echo, flaky.",
    )
  })

  it("构造期拒绝非法 callTimeoutMs", () => {
    expect(() => mcpTools({ transport: broken, callTimeoutMs: 0 })).toThrow(RangeError)
  })
})

// RunStateError 只用于类型层的形状核对；运行时断言用 toMatchObject（vitest 的 rejects.toBeInstanceOf 跨 alias 时类不一定同一）
void RunStateError
