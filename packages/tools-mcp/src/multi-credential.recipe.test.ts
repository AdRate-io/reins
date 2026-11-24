/**
 * 一台服务器多份凭据的配方（`@reinsjs/tools-mcp` README "Several credentials on one server" 的可执行版本，2026-11-19，AdRate 建议 14）。
 *
 * 背景：AdRate 的一个用户可能有多个 TikTok 身份，各是一份 OAuth 凭据、连同一台 MCP 服务器、看到同一份工具目录，
 * 区别只在能动哪些广告账户。模型只管"对哪个账户做什么"，用哪个身份由宿主按入参里的账户 id 决定；
 * 网关式工具 `tool_execute` 把账户 id 嵌在 `params` 里。
 *
 * 用例锁住：① 普通工具与网关工具都按账户路由到对应身份，白名单里不涉及账户的 `tool_list` 走目录身份；
 * ② fail-closed：没有身份能动的账户、认不出账户字段（不回退目录身份）、两个账户要不同身份，都不发出，模型看到宿主写的话；
 * ③ forAccount 拿到的是本 run 的 principal（授权点）；④ accountsOf 纯函数：数字 id、bc_id、非对象入参。
 */

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"
import {
  type CoreEvent,
  type CoreEventOf,
  type Event,
  InMemoryEventLog,
  type RunResult,
  runLoop,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { httpTransport } from "./http.js"
import { mcpTools } from "./mcp-tools.js"
import type { McpRoute, McpTransport } from "./types.js"

// ---- 配方本体（与 tools-mcp README 逐字一致，改一处要同步另一处）----

/** Calls that touch no account. Only these run on the catalog identity. */
const NO_ACCOUNT = new Set(["tool_list", "tool_get"])

/** Every argument that names an account. TikTok's gateway tool nests them under `params`. */
const accountsOf = (name: string, args: unknown): string[] => {
  const top = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>
  const inner = name === "tool_execute" ? top.params : top
  const fields = (typeof inner === "object" && inner !== null ? inner : {}) as Record<string, unknown>
  return ["advertiser_id", "bc_id"]
    .map((field) => fields[field])
    .filter((id) => typeof id === "string" || typeof id === "number")
    .map(String)
}

interface Identities {
  /** The identity used for tools/list and for calls that touch no account */
  catalog: string
  /** Which identity may act on this account for this person; undefined when none may */
  forAccount(account: string, principalId: string | undefined): Promise<string | undefined>
  transport(identity: string): McpTransport
}

const routeByAccount = (ids: Identities): McpRoute => ({
  async keyOf({ name, args }, ctx) {
    if (NO_ACCOUNT.has(name)) return ids.catalog
    const accounts = accountsOf(name, args)
    if (accounts.length === 0) throw new Error(`Cannot tell which account ${name} acts on`)
    const chosen = new Set<string>()
    for (const account of accounts) {
      const identity = await ids.forAccount(account, ctx.principal?.id)
      if (identity === undefined)
        throw new Error(`No connected TikTok identity can access account ${account}`)
      chosen.add(identity)
    }
    if (chosen.size > 1)
      throw new Error(`Accounts ${accounts.join(", ")} need different identities; use one per call`)
    return [...chosen][0] as string
  },
  transportFor: (identity) => ids.transport(identity),
})

// ---- 配方本体结束 ----

// ---- 测试设施：一台网关式服务器（tool_list / tool_execute / advertiser_get），垫片记下每个 tools/call 带的令牌 ----

function gatewayServer() {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "gateway-fixture", version: "0.0.0" })
    server.registerTool("tool_list", { description: "List operations", inputSchema: {} }, async () => ({
      content: [{ type: "text" as const, text: "campaign_get, campaign_update" }],
    }))
    server.registerTool(
      "tool_execute",
      {
        description: "Run an operation",
        inputSchema: { tool_name: z.string(), params: z.record(z.string(), z.unknown()) },
      },
      async ({ tool_name, params }) => ({
        content: [{ type: "text" as const, text: `${tool_name} on ${String(params.advertiser_id)}` }],
      }),
    )
    server.registerTool(
      "advertiser_get",
      { description: "Get advertiser", inputSchema: { advertiser_id: z.string() } },
      async ({ advertiser_id }) => ({
        content: [{ type: "text" as const, text: `advertiser ${advertiser_id}` }],
      }),
    )
    return server
  })
  const calls: { tool: string | undefined; auth: string | null }[] = []
  const shim: typeof fetch = async (input, init) => {
    const req = new Request(input, init)
    if (req.method === "POST") {
      const body = (await req.clone().json()) as { method?: string; params?: { name?: string } }
      if (body.method === "tools/call")
        calls.push({ tool: body.params?.name, auth: req.headers.get("authorization") })
    }
    return handler.fetch(req)
  }
  return { handler, calls, shim }
}

describe("配方：一台服务器多份凭据，按账户路由", () => {
  it("普通工具与网关工具按账户走对应身份；tool_list 走目录身份；没有身份能动的账户不发出；授权点拿到 principal", async () => {
    const fx = gatewayServer()
    const owners: Record<string, string> = {
      "111": "identity-1",
      "222": "identity-2",
      b1: "identity-1",
      b2: "identity-2",
    }
    const asked: { account: string; principalId: string | undefined }[] = []
    const ids: Identities = {
      catalog: "identity-1",
      forAccount: async (account, principalId) => {
        asked.push({ account, principalId })
        return principalId === "boss" ? owners[account] : undefined
      },
      transport: (identity) =>
        httpTransport({ url: "http://mcp.local/mcp", fetch: fx.shim, auth: { token: () => identity } }),
    }
    const tiktok = mcpTools({ transport: ids.transport(ids.catalog), route: routeByAccount(ids) })

    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "tool_list", {})] },
      {
        drafts: [
          callTool("c2", "tool_execute", { tool_name: "campaign_update", params: { advertiser_id: "222" } }),
        ],
      },
      { drafts: [callTool("c3", "advertiser_get", { advertiser_id: "111" })] },
      { drafts: [callTool("c4", "advertiser_get", { advertiser_id: "999" })] },
      // 账户字段名认不出：拒绝，不回退目录身份
      {
        drafts: [
          callTool("c5", "tool_execute", { tool_name: "campaign_get", params: { advertiser_ids: ["111"] } }),
        ],
      },
      // 两个账户要不同身份：拒绝
      {
        drafts: [
          callTool("c6", "tool_execute", {
            tool_name: "bc_link",
            params: { advertiser_id: "111", bc_id: "b2" },
          }),
        ],
      },
      // 两个账户同一身份：照常
      {
        drafts: [
          callTool("c7", "tool_execute", {
            tool_name: "bc_link",
            params: { advertiser_id: "111", bc_id: "b1" },
          }),
        ],
      },
      { drafts: [say("ok")] },
    ])
    const events: Event[] = []
    const gen = runLoop({
      sessionId: "s1",
      log: new InMemoryEventLog(),
      lowering,
      model: { provider: "scripted", id: "scripted" },
      sockets: [tiktok],
      principal: { id: "boss" },
    })
    let result: RunResult
    while (true) {
      const step = await gen.next()
      if (step.done) {
        result = step.value
        break
      }
      events.push(step.value)
    }
    expect(result.status).toBe("done")

    const results = (events as CoreEvent[]).filter(
      (e): e is CoreEventOf<"core.tool_result"> => e.type === "core.tool_result",
    )
    const texts = results.map((r) => r.payload.content.map((c) => (c.type === "text" ? c.text : "")).join(""))
    expect(texts).toEqual([
      "campaign_get, campaign_update",
      "campaign_update on 222",
      "advertiser 111",
      "Tool execution failed: No connected TikTok identity can access account 999",
      "Tool execution failed: Cannot tell which account tool_execute acts on",
      "Tool execution failed: Accounts 111, b2 need different identities; use one per call",
      "bc_link on 111",
    ])
    expect(results.map((r) => r.payload.isError)).toEqual([false, false, false, true, true, true, false])
    expect(fx.calls).toEqual([
      { tool: "tool_list", auth: "Bearer identity-1" },
      { tool: "tool_execute", auth: "Bearer identity-2" },
      { tool: "advertiser_get", auth: "Bearer identity-1" },
      { tool: "tool_execute", auth: "Bearer identity-1" },
    ])
    expect(asked).toEqual([
      { account: "222", principalId: "boss" },
      { account: "111", principalId: "boss" },
      { account: "999", principalId: "boss" },
      { account: "111", principalId: "boss" },
      { account: "b2", principalId: "boss" },
      { account: "111", principalId: "boss" },
      { account: "b1", principalId: "boss" },
    ])

    await tiktok.close()
    await fx.handler.close()
  })

  it("accountsOf：网关工具只看 params、数字 id 转字符串、bc_id 也算、两个都在全收、非对象入参没有账户", () => {
    expect(accountsOf("tool_execute", { tool_name: "x", params: { advertiser_id: 7 } })).toEqual(["7"])
    expect(accountsOf("tool_execute", { advertiser_id: "top-level-is-ignored" })).toEqual([])
    expect(accountsOf("bc_get", { bc_id: "b1" })).toEqual(["b1"])
    expect(accountsOf("x", { advertiser_id: "a", bc_id: "b" })).toEqual(["a", "b"])
    expect(accountsOf("x", { advertiser_id: { nested: 1 } })).toEqual([])
    expect(accountsOf("anything", null)).toEqual([])
    expect(accountsOf("anything", "advertiser_id")).toEqual([])
  })
})
