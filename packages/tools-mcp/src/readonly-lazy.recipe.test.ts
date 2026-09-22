/**
 * 大而平的 MCP 工具表配方（`@reinsjs/tools-mcp` README "Large flat tool tables" 的可执行版本，2026-09-22）。
 *
 * 背景：TikTok for Business 的 flat 端点把 377 件操作各作为一件一等工具下发，每件带 `annotations.readOnlyHint`，
 * 约 200 读 / 130 写。AdRate 的分工是：只让模型看见读工具，写操作走宿主自己的工具（用户授权与记录留在宿主内）；
 * 剩下的约 200 件只读工具全表下发扛不住，要进 lazy-tools 的菜单按需取回。另有一条上游怪癖：业务错误
 * `{"code": 40001, "message": "..."}` 是当**成功**结果返回的，`isError` 不设。
 *
 * 配方只用既有接口：`override` 一行按注解定去留与 `lazy`，再包一层 `execute` 把 code≠0 翻成 isError；
 * `lazyTools()` 必须注册在 `mcpTools()` **之后**——菜单收的是"到它为止已并入的工具"（core `SocketSetup.tools`）。
 *
 * 三个用例分别锁住：① 写工具不进表、读工具首轮只在菜单里、取回后可调用、业务错误成 isError；
 * ② 顺序反了（lazyTools 在前）不出错但退化为全表下发，两处告警指出顺序（反面，这是"顺序约束"存在的理由）；
 * ③ 配方纯函数：非 JSON / code 为 0 / 已是 isError 的结果原样放行。
 */
import { lazyTools, TOOL_FIND_TOOL_NAME } from "@reinsjs/brain"
import {
  type CoreEvent,
  type CoreEventOf,
  type Event,
  InMemoryEventLog,
  normalizeToolOutput,
  type RunResult,
  runLoop,
  type Tool,
  type ToolResult,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { mcpTools } from "./mcp-tools.js"
import { fixtureServer } from "./test-utils.js"
import type { McpToolsOptions } from "./types.js"

// ---- 配方本体（与 tools-mcp README 逐字一致，改一处要同步另一处）----

/** 上游把业务错误当成功结果：text 里是 `{"code": <非 0>, "message": ...}`。返回一句可读的错误说明，不是业务错误则 undefined */
const businessErrorOf = (result: ToolResult): string | undefined => {
  if (result.isError) return undefined
  for (const part of result.content) {
    if (part.type !== "text") continue
    try {
      const body = JSON.parse(part.text) as { code?: unknown; message?: unknown }
      if (typeof body.code === "number" && body.code !== 0)
        return `Upstream error ${body.code}: ${String(body.message ?? "")}`
    } catch {
      // 不是 JSON 就不是业务错误信封
    }
  }
  return undefined
}

/** 包一层 execute：业务错误照原文给模型，但标 isError，让重试 / 审批策略 / 宿主观测都看得见 */
const withBusinessErrors = (tool: Tool): Tool => ({
  ...tool,
  async execute(input, ctx) {
    const result = normalizeToolOutput(await tool.execute?.(input, ctx))
    const error = businessErrorOf(result)
    return error ? { content: [...result.content, { type: "text", text: error }], isError: true } : result
  },
})

/** 只读的进菜单按需取回；其余（写、未标注）一律不给模型——写操作走宿主自己的工具 */
const readOnlyLazy: McpToolsOptions["override"] = (tool, info) =>
  info.annotations?.readOnlyHint === true ? withBusinessErrors({ ...tool, lazy: true }) : false

// ---- 用例 ----

const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"

function deterministic() {
  let t = 1_800_000_000_000
  let n = 0
  return { now: () => ++t, newId: () => `id${++n}` }
}

async function drain(gen: AsyncGenerator<Event, RunResult>): Promise<RunResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

async function all(log: InMemoryEventLog): Promise<CoreEvent[]> {
  const out: CoreEvent[] = []
  for await (const e of log.read(SESSION)) out.push(e as CoreEvent)
  return out
}

const resultOf = (events: readonly CoreEvent[], toolCallId: string) =>
  events.find(
    (e): e is CoreEventOf<"core.tool_result"> =>
      e.type === "core.tool_result" && e.payload.toolCallId === toolCallId,
  ) as CoreEventOf<"core.tool_result">
const textOf = (r: CoreEventOf<"core.tool_result">) =>
  r.payload.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("")
const names = (tools: readonly { name: string }[] | undefined) => (tools ?? []).map((t) => t.name)

/** 夹具服务器自带 echo（只读）/ drop_table（破坏性）/ flaky / big，再加一件 TikTok 形态的只读工具与一件写工具 */
function tiktokLikeServer() {
  const fx = fixtureServer("tiktok")
  fx.server.registerTool(
    "report_get",
    {
      description: "Get an ad report.\nReturns the TikTok envelope { code, message, data }.",
      inputSchema: { advertiser_id: z.string(), fail: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ advertiser_id, fail }) => ({
      content: [
        {
          type: "text" as const,
          text: fail
            ? JSON.stringify({ code: 40001, message: "advertiser not authorized", data: {} })
            : JSON.stringify({ code: 0, message: "OK", data: { advertiser_id, spend: 12.5 } }),
        },
      ],
    }),
  )
  fx.server.registerTool(
    "ad_create",
    { description: "Create an ad", inputSchema: { name: z.string() } },
    async ({ name }) => ({ content: [{ type: "text" as const, text: `created ${name}` }] }),
  )
  return fx
}

describe("配方：只读 MCP 工具进 lazy-tools 菜单，写工具不给模型，业务错误转 isError", () => {
  it("① mcpTools 在前、lazyTools 在后：菜单只列只读工具；首轮工具表只有 tool_find；取回后可调用；code≠0 成 isError", async () => {
    const fx = tiktokLikeServer()
    const warnings: string[] = []
    const mcp = mcpTools({ transport: fx.transport, override: readOnlyLazy, warn: (m) => warnings.push(m) })
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", TOOL_FIND_TOOL_NAME, { names: ["report_get"] })] },
      {
        drafts: [
          callTool("c2", "report_get", { advertiser_id: "adv_1" }),
          callTool("c3", "report_get", { advertiser_id: "adv_2", fail: true }),
          callTool("c4", "ad_create", { name: "x" }),
        ],
      },
      { drafts: [say("done")] },
    ])
    const log = new InMemoryEventLog()
    const result = await drain(
      runLoop({
        sessionId: SESSION,
        log,
        lowering,
        model: MODEL,
        sockets: [mcp, lazyTools({ warn: (m) => warnings.push(m) })],
        input: "巡检",
        ...deterministic(),
      }),
    )
    expect(result.status).toBe("done")

    // 菜单：只有两件只读工具；写的、未标注的连菜单都不上（override 返回 false 就不在绑定表里）
    const prompt = lowering.requests[0]?.systemPrompt ?? ""
    expect(prompt).toContain("- echo: Echo the text back")
    expect(prompt).toContain("- report_get: Get an ad report.")
    for (const absent of ["drop_table", "flaky", "big", "ad_create"]) expect(prompt).not.toContain(absent)
    // 首轮请求：只读工具都藏着，只剩 tool_find；取回 report_get 后下一轮它出现在表里
    expect(names(lowering.requests[0]?.tools)).toEqual([TOOL_FIND_TOOL_NAME])
    expect(names(lowering.requests[1]?.tools)).toEqual(["report_get", TOOL_FIND_TOOL_NAME])

    const events = await all(log)
    const bound = events.find((e) => e.type === "core.tools_bound") as CoreEventOf<"core.tools_bound">
    expect(bound.payload.toolNames).toEqual(["echo", "report_get", TOOL_FIND_TOOL_NAME])
    // 取回结果 trust=system（工具说明与 tools 块同一信任层级）
    expect(resultOf(events, "c1").payload.isError).toBe(false)
    expect(resultOf(events, "c1").trust).toBe("system")
    // 正常结果原样；业务错误：原文保留、追加一句说明、isError
    expect(resultOf(events, "c2").payload.isError).toBe(false)
    expect(textOf(resultOf(events, "c2"))).toContain('"spend":12.5')
    const failed = resultOf(events, "c3")
    expect(failed.payload.isError).toBe(true)
    expect(textOf(failed)).toContain('"code":40001')
    expect(textOf(failed)).toContain("Upstream error 40001: advertiser not authorized")
    // 写工具不在绑定表里：调用是"未知工具"，不会打到服务器
    expect(resultOf(events, "c4").payload.isError).toBe(true)
    expect(textOf(resultOf(events, "c4"))).toContain("Unknown tool: ad_create")
    expect(warnings).toEqual([])
    await mcp.close()
  })

  it("② 反面：lazyTools 注册在 mcpTools 之前——不出错，但只读工具每轮全量下发，两处各告警一次指出顺序", async () => {
    const fx = tiktokLikeServer()
    const warnings: string[] = []
    const mcp = mcpTools({ transport: fx.transport, override: readOnlyLazy })
    const lowering = new ScriptedLowering([{ drafts: [say("one")] }, { drafts: [say("two")] }])
    const log = new InMemoryEventLog()
    for (const input of ["一", "二"]) {
      const result = await drain(
        runLoop({
          sessionId: SESSION,
          log,
          lowering,
          model: MODEL,
          sockets: [lazyTools({ warn: (m) => warnings.push(m) }), mcp],
          input,
          ...deterministic(),
        }),
      )
      expect(result.status).toBe("done")
    }
    // 菜单没注册（lazyTools 起步时前面一件工具都没有），只读工具照旧在每个请求的工具表里
    for (const req of lowering.requests) {
      expect(req.systemPrompt).toBeUndefined()
      expect(names(req.tools)).toEqual(["echo", "report_get"])
    }
    // 两个 lazyTools 实例：起步各一条"没有 lazy 工具"，beforeModel 各一条"注册顺序"
    expect(warnings.filter((w) => w.includes("No tool bound before lazyTools()"))).toHaveLength(2)
    const late = warnings.filter((w) => w.includes("registered after lazyTools()"))
    expect(late).toHaveLength(2)
    for (const w of late) expect(w).toContain("echo, report_get")
    await mcp.close()
  })

  it("③ 配方纯函数：非 JSON、code 为 0、已是 isError 的结果原样放行；多段内容里任一段是错误信封即算错误", async () => {
    const pass = (content: ToolResult["content"], isError?: boolean) =>
      businessErrorOf({ content, ...(isError === undefined ? {} : { isError }) })
    expect(pass([{ type: "text", text: "plain text" }])).toBeUndefined()
    expect(pass([{ type: "text", text: JSON.stringify({ code: 0, data: {} }) }])).toBeUndefined()
    expect(pass([{ type: "text", text: JSON.stringify({ code: "40001" }) }])).toBeUndefined() // 字符串 code 不算
    expect(pass([{ type: "text", text: JSON.stringify({ code: 40001 }) }], true)).toBeUndefined() // 已是 isError 不重复判
    expect(
      pass([
        { type: "text", text: "header" },
        { type: "text", text: JSON.stringify({ code: 50000, message: "internal" }) },
      ]),
    ).toBe("Upstream error 50000: internal")
    // 包装后的工具：没有 execute 的（客户端侧工具）包了也不会炸
    const wrapped = withBusinessErrors({ name: "t", description: "", inputSchema: {} })
    expect(normalizeToolOutput(await wrapped.execute?.({}, {} as never))).toEqual({
      content: [{ type: "text", text: "" }],
    })
  })
})
