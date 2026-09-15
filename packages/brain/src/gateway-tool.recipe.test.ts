/**
 * 网关型工具的审批配方（`@reinsjs/tools-mcp` README "Gateway-style servers" 的可执行版本）。
 *
 * 背景：有些 MCP 服务器把几百个操作收进**一件**工具转发（TikTok for Business 的 `tool_execute` 就是这样：
 * 41 件原生工具 + 3 件元工具，另外 330 多个操作只活在服务器的注册表里，全部经 `tool_execute(tool_name, params)`
 * 代为执行）。这对循环没有影响——工具表整个 run 不变，宪法与缓存前缀都不受损——**但按工具名写的审批策略会整个失效**：
 * 建广告、改预算、删资产组在审批眼里都叫 `tool_execute`，真正要干什么藏在入参里。
 *
 * 下面三个用例分别锁住：① 按名字写的规则拦不住（反面，这是本配方存在的理由）；② 按入参写就拦得住；
 * ③ 缺省 byRisk 是 fail-closed 的——不配任何规则时连只读转发也要问人，宁可烦不可漏。
 */
import {
  type CoreEventOf,
  defineTool,
  type Event,
  InMemoryEventLog,
  type LoopConfig,
  type RunResult,
  runLoop,
  type Tool,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { approval, type PolicyRule } from "./approval/index.js"

// ---- 配方本体（与 tools-mcp README 逐字一致，改一处要同步另一处）----

/** 网关工具真正要执行的操作名藏在这个入参字段里 */
const operationOf = (args: unknown): string =>
  typeof args === "object" && args !== null && "tool_name" in args
    ? String((args as { tool_name?: unknown }).tool_name ?? "")
    : ""

/** 写操作要问人：判据是**入参里的操作名**，不是工具名 */
const gatewayWrites: PolicyRule = {
  id: "gateway.writes",
  match: (call) =>
    call.name === "tool_execute" && /_(create|update|delete|upload)$/.test(operationOf(call.args)),
  summary: (call) => `TikTok ${operationOf(call.args)}`,
}

/** 只读转发不问人：同样按入参判 */
const gatewayReads: PolicyRule = {
  id: "gateway.reads",
  match: (call) => call.name === "tool_execute" && /_(get|list|search)$/.test(operationOf(call.args)),
}

// ---- 下面是把配方跑起来的脚手架 ----

/** 网关工具：入参里的 tool_name 决定真正执行什么。schema 刻意宽松，与真服务器一致 */
function gatewayTool(executed: string[]): Tool {
  return defineTool({
    name: "tool_execute",
    description: "Executes a TikTok API tool by name.",
    // 真服务器没有声明 annotations，翻过来就没有 risk —— 缺省 byRisk 会把它当"要问人"
    inputSchema: {
      type: "object",
      properties: { tool_name: { type: "string" }, params: { type: "object" } },
    },
    execute: (args) => {
      const op = operationOf(args)
      executed.push(op)
      return { content: [{ type: "text" as const, text: `{"code":0,"data":{"op":"${op}"}}` }] }
    },
  })
}

/** 只读的元工具，任何配方里都该直接放行 */
const toolList = defineTool({
  name: "tool_list",
  description: "Lists every tool reachable via the dispatcher.",
  inputSchema: { type: "object", properties: {} },
  risk: "low",
  execute: () => ({ content: [{ type: "text" as const, text: "{}" }] }),
})

function config(sockets: NonNullable<LoopConfig["sockets"]>, tools: readonly Tool[], op: string): LoopConfig {
  return {
    sessionId: "s1",
    log: new InMemoryEventLog(),
    model: { provider: "x", id: "y" },
    tools,
    sockets,
    lowering: new ScriptedLowering([
      { drafts: [callTool("c1", "tool_execute", { tool_name: op, params: {} })] },
      { drafts: [say("done")] },
    ]),
  }
}

async function run(gen: AsyncGenerator<Event, RunResult>): Promise<{ events: Event[]; result: RunResult }> {
  const events: Event[] = []
  while (true) {
    const step = await gen.next()
    if (step.done) return { events, result: step.value }
    events.push(step.value)
  }
}

const deniedReason = (events: readonly Event[]): string | undefined =>
  (
    events.find((e) => e.type === "core.approval_decision") as
      | CoreEventOf<"core.approval_decision">
      | undefined
  )?.payload.reason

describe("网关型工具的审批配方", () => {
  it("反面：按工具名写的规则拦不住网关——删除操作照跑，一条审批事件都没有", async () => {
    const executed: string[] = []
    const tools = [gatewayTool(executed), toolList]
    // 宿主的常规写法：按名字 glob 挡掉删除类工具。网关下所有操作都叫 tool_execute，这条永远命中不了
    const sockets = [approval({ deny: ["*_delete"], allow: ["*"] })]
    const { result } = await run(runLoop(config(sockets, tools, "bc_asset_group_delete")))

    expect(result.status).toBe("done")
    expect(executed).toEqual(["bc_asset_group_delete"]) // 真的执行了 —— 这就是那个坑
  })

  it("正面：按入参写的规则拦得住写操作，只读转发照常放行", async () => {
    const executed: string[] = []
    const tools = [gatewayTool(executed), toolList]
    const sockets = [approval({ deny: [gatewayWrites], allow: [gatewayReads, "tool_list"] })]

    // ① 删除：命中 deny 段，不执行，模型看到拒绝理由
    const del = await run(runLoop(config(sockets, tools, "bc_asset_group_delete")))
    expect(executed).toEqual([])
    expect(deniedReason(del.events)).toContain("gateway.writes")

    // ② 只读：命中 allow 段，不问人直接跑（allow 刻意不留事件，看 tool_call / tool_result 即可）
    const get = await run(runLoop(config(sockets, tools, "advertiser_info_get")))
    expect(executed).toEqual(["advertiser_info_get"])
    expect(get.events.some((e) => e.type === "core.approval_request")).toBe(false)
  })

  it("要人批而不是一律拒：写操作走 ask 段，run 以 paused(approval) 收场，审批摘要带真实操作名", async () => {
    const executed: string[] = []
    const tools = [gatewayTool(executed), toolList]
    const sockets = [approval({ ask: [gatewayWrites], allow: [gatewayReads, "tool_list"] })]
    const { events, result } = await run(runLoop(config(sockets, tools, "campaign_create")))

    expect(result.status).toBe("paused")
    expect(executed).toEqual([])
    const req = events.find((e) => e.type === "core.approval_request") as
      | CoreEventOf<"core.approval_request">
      | undefined
    // 审批人看到的是"要建广告系列"，不是没信息量的 "tool_execute"
    expect(req?.payload.summary).toBe("TikTok campaign_create")
    expect(req?.payload.policyId).toBe("gateway.writes")
  })

  it("缺省 fail-closed：一条规则都不配时，连只读转发也要问人（宁可烦不可漏）", async () => {
    const executed: string[] = []
    const tools = [gatewayTool(executed), toolList]
    // 服务器没声明 annotations → 翻过来的工具没有 risk → unmatched 缺省 byRisk 判成 ask
    const { result } = await run(runLoop(config([approval({})], tools, "advertiser_info_get")))

    expect(result.status).toBe("paused")
    expect(executed).toEqual([])
  })
})
