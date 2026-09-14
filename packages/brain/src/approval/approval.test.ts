import {
  BUILTIN_APPROVAL_POLICY,
  type CoreEvent,
  type CoreEventOf,
  defineTool,
  type Event,
  InMemoryEventLog,
  type LoopConfig,
  type RunResult,
  runLoop,
  type Socket,
  type Tool,
  type TurnContext,
} from "@reinsjs/core"
import { callTool, ScriptedLowering, say } from "@reinsjs/core/testing"
import { describe, expect, it, vi } from "vitest"
import {
  APPROVAL_POLICY_IDS,
  approval,
  defaultSummary,
  evaluatePolicy,
  globToRegExp,
  normalizeRule,
  type PolicyCall,
  type PolicyRule,
} from "./approval.js"
import { APPROVAL_RULES } from "./rules.js"

const MODEL = { provider: "scripted", id: "scripted" }
const SESSION = "s1"
type ToolResult = CoreEventOf<"core.tool_result">
type Decision = CoreEventOf<"core.approval_decision">

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
const decisionsOf = (events: readonly Event[]) =>
  events.filter((e): e is Decision => e.type === "core.approval_decision")

/** 三个工具：只读（risk low）、写（risk high）、没声明 risk 的 */
const executed: string[] = []
const readTool: Tool = defineTool<{ path: string }>({
  name: "read_file",
  description: "读文件",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  risk: "low",
  execute: ({ path }) => {
    executed.push(`read_file:${path}`)
    return `内容 of ${path}`
  },
})
const deployTool: Tool = defineTool<{ env: string }>({
  name: "deploy",
  description: "上线",
  inputSchema: { type: "object", properties: { env: { type: "string" } } },
  risk: "high",
  execute: ({ env }) => {
    executed.push(`deploy:${env}`)
    return `已上线 ${env}`
  },
})
const plainTool: Tool = defineTool<{ q: string }>({
  name: "search",
  description: "没声明 risk",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  execute: ({ q }) => {
    executed.push(`search:${q}`)
    return `结果 ${q}`
  },
})

/** 续跑用：去掉 input（exactOptionalPropertyTypes 下不能写 input: undefined） */
function resumed(cfg: LoopConfig): LoopConfig {
  const { input: _input, ...rest } = cfg
  return rest
}

function config(
  lowering: ScriptedLowering,
  log: InMemoryEventLog,
  extra: Partial<LoopConfig> = {},
): LoopConfig {
  return {
    sessionId: SESSION,
    log,
    lowering,
    model: MODEL,
    tools: [readTool, deployTool, plainTool],
    systemPrompt: "你是助手",
    input: "干活",
    sockets: [approval()],
    ...deterministic(),
    ...extra,
  }
}

// ---- 纯函数 ----

describe("approval：规则简写与摘要", () => {
  it("glob 只认 *，其余字符按字面匹配，整串匹配", () => {
    expect(globToRegExp("read_*").test("read_file")).toBe(true)
    expect(globToRegExp("read_*").test("xread_file")).toBe(false)
    expect(globToRegExp("*").test("anything")).toBe(true)
    expect(globToRegExp("a.b").test("axb")).toBe(false)
    expect(globToRegExp("a.b").test("a.b")).toBe(true)
    expect(globToRegExp("f(x)").test("f(x)")).toBe(true)
  })

  it("字符串规则规范成 id 为 name:<pattern> 的按名匹配", async () => {
    const rule = normalizeRule("rm_*")
    expect(rule.id).toBe("name:rm_*")
    const call = (name: string): PolicyCall => ({ toolCallId: "c", name, args: {}, tool: undefined })
    expect(await rule.match(call("rm_rf"), {} as TurnContext)).toBe(true)
    expect(await rule.match(call("read"), {} as TurnContext)).toBe(false)
    const obj: PolicyRule = { id: "x", match: () => true }
    expect(normalizeRule(obj)).toBe(obj)
  })

  it("缺省摘要是 name(入参 JSON)，过长截断加省略号", () => {
    const call: PolicyCall = { toolCallId: "c", name: "deploy", args: { env: "prod" }, tool: deployTool }
    expect(defaultSummary(call, 200)).toBe('deploy({"env":"prod"})')
    expect(defaultSummary(call, 5)).toBe('deploy({"env…)')
    expect(defaultSummary({ ...call, args: undefined }, 200)).toBe("deploy()")
  })
})

/** 只给 needsApproval 函数拼 ToolContext 要用到的字段 */
const stubCtx = (extra: Partial<TurnContext> = {}): TurnContext =>
  ({
    session: { id: SESSION, turn: 1 },
    log: new InMemoryEventLog(),
    emit: () => {},
    ...extra,
  }) as TurnContext

describe("approval：evaluatePolicy 管线", () => {
  const ctx = stubCtx()
  const call = (tool: Tool | undefined, args: unknown = {}): PolicyCall => ({
    toolCallId: "c1",
    name: tool?.name ?? "ghost",
    args,
    tool,
  })
  const run = (
    c: PolicyCall,
    stages: Partial<{ deny: PolicyRule[]; ask: PolicyRule[]; allow: PolicyRule[] }> = {},
    unmatched: "byRisk" | "ask" | "deny" = "byRisk",
    onError?: (rule: string, err: unknown) => void,
  ) =>
    evaluatePolicy(
      c,
      ctx,
      { deny: stages.deny ?? [], ask: stages.ask ?? [], allow: stages.allow ?? [] },
      { unmatched, maxSummaryChars: 200, ...(onError ? { onError } : {}) },
    )
  const always = (id: string, extra: Partial<PolicyRule> = {}): PolicyRule => ({
    id,
    match: () => true,
    ...extra,
  })

  it("未知工具一律 deny，规则都不用看", async () => {
    const out = await run(call(undefined), { allow: [always("everything")] })
    expect(out).toEqual({
      verdict: "deny",
      policyId: APPROVAL_POLICY_IDS.unknownTool,
      reason: "未知工具：ghost",
    })
  })

  it("deny 先于 ask 先于 allow；deny 不可被 allow 覆盖", async () => {
    const stages = { deny: [always("d")], ask: [always("a")], allow: [always("ok")] }
    expect(await run(call(readTool), stages)).toMatchObject({ verdict: "deny", policyId: "d" })
    expect(await run(call(readTool), { ask: stages.ask, allow: stages.allow })).toMatchObject({
      verdict: "ask",
      policyId: "a",
    })
    expect(await run(call(readTool), { allow: stages.allow })).toEqual({ verdict: "allow", policyId: "ok" })
  })

  it("段内首匹配即定：不匹配的规则跳过", async () => {
    const out = await run(call(readTool), {
      deny: [
        { id: "no", match: () => false },
        { id: "yes", match: () => true, reason: "不许读" },
      ],
    })
    expect(out).toEqual({ verdict: "deny", policyId: "yes", reason: "不许读" })
  })

  it("规则可自定义 summary 与 reason；缺省 reason 带策略 id 与工具名", async () => {
    const asked = await run(call(deployTool, { env: "prod" }), {
      ask: [always("prod-gate", { summary: (c) => `要上线到 ${(c.args as { env: string }).env}` })],
    })
    expect(asked).toEqual({ verdict: "ask", policyId: "prod-gate", summary: "要上线到 prod" })
    const denied = await run(call(deployTool), { deny: [always("freeze")] })
    expect(denied).toEqual({ verdict: "deny", policyId: "freeze", reason: "策略 freeze 不允许调用 deploy" })
  })

  it("工具自己的 needsApproval 是 ask 段的最后一条：布尔与函数都认，函数拿到入参", async () => {
    const seen: unknown[] = []
    const t: Tool = defineTool<{ env: string }>({
      ...deployTool,
      needsApproval: (input) => {
        seen.push(input)
        return input.env === "prod"
      },
    } as Tool<{ env: string }>)
    expect(await run(call(t, { env: "prod" }), { allow: [always("ok")] })).toEqual({
      verdict: "ask",
      policyId: BUILTIN_APPROVAL_POLICY,
      summary: 'deploy({"env":"prod"})',
    })
    // 函数说不用问 → 继续走 allow 段
    expect(await run(call(t, { env: "staging" }), { allow: [always("ok")] })).toEqual({
      verdict: "allow",
      policyId: "ok",
    })
    expect(seen).toEqual([{ env: "prod" }, { env: "staging" }])
    // deny 段仍在 needsApproval 之前
    expect(await run(call(t, { env: "prod" }), { deny: [always("d")] })).toMatchObject({ verdict: "deny" })
    expect(await run(call({ ...readTool, needsApproval: true }))).toMatchObject({
      verdict: "ask",
      policyId: BUILTIN_APPROVAL_POLICY,
    })
  })

  it("三段都没命中：缺省按 risk —— low 放行，medium / high / 未声明 先问人", async () => {
    expect(await run(call(readTool))).toEqual({ verdict: "allow", policyId: "approval.risk.low" })
    expect(await run(call(deployTool, { env: "x" }))).toEqual({
      verdict: "ask",
      policyId: "approval.risk.high",
      summary: 'deploy({"env":"x"})',
    })
    expect(await run(call({ ...deployTool, risk: "medium" }))).toMatchObject({
      verdict: "ask",
      policyId: "approval.risk.medium",
    })
    expect(await run(call(plainTool))).toMatchObject({ verdict: "ask", policyId: "approval.risk.undeclared" })
  })

  it("unmatched 可改成一律 ask 或一律 deny", async () => {
    expect(await run(call(readTool), {}, "deny")).toEqual({
      verdict: "deny",
      policyId: APPROVAL_POLICY_IDS.unmatched,
      reason: "没有策略允许调用 read_file",
    })
    expect(await run(call(readTool, { path: "a" }), {}, "ask")).toEqual({
      verdict: "ask",
      policyId: APPROVAL_POLICY_IDS.unmatched,
      summary: 'read_file({"path":"a"})',
    })
  })

  it("fail-closed：任一段规则抛错即 deny，by 为出错规则，后面的规则不再看，onError 收到通知", async () => {
    const onError = vi.fn()
    const boom: PolicyRule = {
      id: "boom",
      match: () => {
        throw new Error("网断了")
      },
    }
    const inAllow = await run(call(readTool), { allow: [boom, always("ok")] }, "byRisk", onError)
    expect(inAllow).toEqual({
      verdict: "deny",
      policyId: "boom",
      reason: "策略 boom 求值异常，按拒绝处理：网断了",
    })
    expect(onError).toHaveBeenCalledWith("boom", expect.any(Error))
    // ask 段抛错同样 deny，即使 allow 段本会放行
    expect(await run(call(readTool), { ask: [boom], allow: [always("ok")] })).toMatchObject({
      verdict: "deny",
    })
    // 非 Error 的抛出也能落成文字
    const weird: PolicyRule = {
      id: "weird",
      match: () => {
        throw "字符串"
      },
    }
    expect(await run(call(readTool), { deny: [weird] })).toMatchObject({
      reason: "策略 weird 求值异常，按拒绝处理：字符串",
    })
  })

  it("fail-closed 同样管 needsApproval 函数", async () => {
    const t: Tool = {
      ...deployTool,
      needsApproval: async () => {
        throw new Error("策略服务 500")
      },
    }
    expect(await run(call(t), { allow: [always("ok")] })).toEqual({
      verdict: "deny",
      policyId: BUILTIN_APPROVAL_POLICY,
      reason: "策略 tool.needsApproval 求值异常，按拒绝处理：策略服务 500",
    })
  })

  it("规则拿到 ctx，可按 principal 判定", async () => {
    const byPrincipal: PolicyRule = { id: "admin-only", match: (_c, c) => c.principal?.id !== "admin" }
    expect(await run(call(deployTool), { deny: [byPrincipal] })).toMatchObject({ verdict: "deny" })
    const adminCtx = stubCtx({ principal: { id: "admin" } })
    const out = await evaluatePolicy(
      call(deployTool),
      adminCtx,
      { deny: [byPrincipal], ask: [], allow: [always("ok")] },
      { unmatched: "byRisk", maxSummaryChars: 200 },
    )
    expect(out).toEqual({ verdict: "allow", policyId: "ok" })
  })
})

// ---- 与循环合体 ----

describe("approval × runLoop", () => {
  it("规则提示是静态贡献；rules:false 不碰系统提示", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [say("好")] }])
    await drain(runLoop(config(lowering, log)))
    expect(lowering.requests[0]?.systemPrompt).toBe(`你是助手\n\n${APPROVAL_RULES}`)

    const log2 = new InMemoryEventLog()
    const lowering2 = new ScriptedLowering([{ drafts: [say("好")] }])
    await drain(runLoop(config(lowering2, log2, { sockets: [approval({ rules: false })] })))
    expect(lowering2.requests[0]?.systemPrompt).toBe("你是助手")
    expect(lowering2.requests[0]?.tools?.map((t) => t.name)).toEqual(["read_file", "deploy", "search"])
  })

  it("allow：只读工具直接执行，时间线里没有任何审批事件", async () => {
    executed.length = 0
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "read_file", { path: "/a" })] },
      { drafts: [say("读到了")] },
    ])
    const { result } = await drain(runLoop(config(lowering, log)))
    expect(result.status).toBe("done")
    expect(executed).toEqual(["read_file:/a"])
    const logged = await all(log)
    expect(types(logged)).not.toContain("approval_request")
    expect(types(logged)).not.toContain("approval_decision")
    expect(textOf(resultOf(logged, "c1"))).toBe("内容 of /a")
  })

  it("deny：approval_decision(by=策略 id) 排在 tool_result(isError) 之前，工具没跑，模型只看到带策略名的错误", async () => {
    executed.length = 0
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "deploy", { env: "prod" })] },
      { drafts: [say("那算了")] },
    ])
    const { result } = await drain(
      runLoop(config(lowering, log, { sockets: [approval({ deny: ["deploy"] })] })),
    )
    expect(result.status).toBe("done")
    expect(executed).toEqual([])
    const logged = await all(log)
    const tl = types(logged)
    expect(tl.indexOf("approval_decision")).toBeGreaterThan(tl.indexOf("tool_call"))
    expect(tl.indexOf("approval_decision")).toBe(tl.indexOf("tool_result") - 1)
    expect(decisionsOf(logged)[0]?.payload).toEqual({
      toolCallId: "c1",
      approved: false,
      by: "name:deploy",
      reason: "策略 name:deploy 不允许调用 deploy",
    })
    expect(decisionsOf(logged)[0]?.actor).toBe("system")
    const res = resultOf(logged, "c1")
    expect(res.payload.isError).toBe(true)
    expect(textOf(res)).toBe("工具调用被拦截：策略 name:deploy 不允许调用 deploy")
    // 第二轮模型看到结果，看不到决策事件
    expect(types(lowering.requests[1]?.events ?? [])).toEqual(["user_message", "tool_call", "tool_result"])
  })

  it("ask：转审批暂停，policyId / summary 来自管线；宿主批准后续跑执行", async () => {
    executed.length = 0
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "deploy", { env: "prod" })] },
      { drafts: [say("上线完成")] },
    ])
    const cfg = config(lowering, log)
    const first = await drain(runLoop(cfg))
    expect(first.result.status).toBe("paused")
    if (first.result.status !== "paused") throw new Error("unreachable")
    expect(first.result.reason).toBe("approval")
    expect(first.result.interruptions).toEqual([
      expect.objectContaining({
        kind: "approval",
        toolCallId: "c1",
        request: { toolCallId: "c1", policyId: "approval.risk.high", summary: 'deploy({"env":"prod"})' },
      }),
    ])
    expect(executed).toEqual([])

    const second = await drain(
      runLoop({
        ...resumed(cfg),
        resume: first.result.state,
        decisions: [{ toolCallId: "c1", approved: true, by: "boss" }],
      }),
    )
    expect(second.result.status).toBe("done")
    expect(executed).toEqual(["deploy:prod"])
    expect(textOf(resultOf(await all(log), "c1"))).toBe("已上线 prod")
  })

  it("未声明 risk 的工具缺省先问人；unmatched='deny' 时一律拒", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([{ drafts: [callTool("c1", "search", { q: "x" })] }])
    const { result } = await drain(runLoop(config(lowering, log)))
    expect(result.status).toBe("paused")
    if (result.status !== "paused") throw new Error("unreachable")
    expect(result.interruptions[0]).toMatchObject({ request: { policyId: "approval.risk.undeclared" } })

    const log2 = new InMemoryEventLog()
    const lowering2 = new ScriptedLowering([
      { drafts: [callTool("c1", "read_file", { path: "/a" })] },
      { drafts: [say("好")] },
    ])
    await drain(runLoop(config(lowering2, log2, { sockets: [approval({ unmatched: "deny" })] })))
    expect(decisionsOf(await all(log2))[0]?.payload).toMatchObject({
      approved: false,
      by: APPROVAL_POLICY_IDS.unmatched,
    })
  })

  it("未知工具：留 approval_decision(by=approval.unknown_tool) 再给模型错误结果", async () => {
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "ghost", {})] },
      { drafts: [say("好")] },
    ])
    await drain(runLoop(config(lowering, log)))
    const logged = await all(log)
    expect(decisionsOf(logged)[0]?.payload).toMatchObject({
      approved: false,
      by: APPROVAL_POLICY_IDS.unknownTool,
    })
    expect(textOf(resultOf(logged, "c1"))).toBe("工具调用被拦截：未知工具：ghost")
  })

  it("管线判定的是改写后的入参：前面的钩子 rewrite 后，按入参写的 deny 规则仍能拦住", async () => {
    executed.length = 0
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "read_file", { path: "/tmp/ok" })] },
      { drafts: [say("好")] },
    ])
    const rewriter: Socket = { beforeTool: () => ({ rewrite: { path: "/etc/passwd" } }) }
    const noEtc: PolicyRule = {
      id: "no-etc",
      match: (c) => String((c.args as { path?: string }).path ?? "").startsWith("/etc/"),
    }
    await drain(runLoop(config(lowering, log, { sockets: [rewriter, approval({ deny: [noEtc] })] })))
    expect(executed).toEqual([])
    expect(decisionsOf(await all(log))[0]?.payload).toMatchObject({ approved: false, by: "no-etc" })
  })

  it("deny 不可被覆盖：宿主已批准、前面的钩子还在 defer，排在后面的 deny 规则照样拦", async () => {
    executed.length = 0
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "deploy", { env: "prod" })] },
      { drafts: [say("好")] },
    ])
    // 第一跑：只有 ask 规则 → 暂停
    const gate: Socket = { beforeTool: () => ({ defer: { policyId: "gate", summary: "问一下" } }) }
    const cfg = config(lowering, log, { sockets: [gate, approval()] })
    const first = await drain(runLoop(cfg))
    expect(first.result.status).toBe("paused")
    if (first.result.status !== "paused") throw new Error("unreachable")
    expect(first.result.interruptions[0]).toMatchObject({ request: { policyId: "gate" } })

    // 续跑：宿主批了，但策略换成了 deny —— gate 的 defer 被略过（已批准），approval 的 deny 仍拦住
    const second = await drain(
      runLoop({
        ...resumed(cfg),
        sockets: [gate, approval({ deny: ["deploy"] })],
        resume: first.result.state,
        decisions: [{ toolCallId: "c1", approved: true, by: "boss" }],
      }),
    )
    expect(second.result.status).toBe("done")
    expect(executed).toEqual([])
    const logged = await all(log)
    expect(decisionsOf(logged).map((d) => [d.payload.by, d.payload.approved])).toEqual([
      ["boss", true],
      ["name:deploy", false],
    ])
    expect(resultOf(logged, "c1").payload.isError).toBe(true)
  })

  it("fail-closed 进时间线：规则抛错 → approval_decision 记异常原因，warn 收到告警，工具没跑", async () => {
    executed.length = 0
    const warn = vi.fn()
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      { drafts: [callTool("c1", "read_file", { path: "/a" })] },
      { drafts: [say("好")] },
    ])
    const boom: PolicyRule = {
      id: "acl",
      match: async () => {
        throw new Error("ACL 服务超时")
      },
    }
    await drain(runLoop(config(lowering, log, { sockets: [approval({ allow: [boom], warn })] })))
    expect(executed).toEqual([])
    expect(decisionsOf(await all(log))[0]?.payload).toEqual({
      toolCallId: "c1",
      approved: false,
      by: "acl",
      reason: "策略 acl 求值异常，按拒绝处理：ACL 服务超时",
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain("acl")
  })

  it("并行调用各自判定：放行的执行、要问的暂停、拒绝的留痕，一次 run 里同时发生", async () => {
    executed.length = 0
    const log = new InMemoryEventLog()
    const lowering = new ScriptedLowering([
      {
        drafts: [
          callTool("c1", "read_file", { path: "/a" }),
          callTool("c2", "deploy", { env: "prod" }),
          callTool("c3", "search", { q: "x" }),
        ],
      },
    ])
    const { result } = await drain(
      runLoop(config(lowering, log, { sockets: [approval({ deny: ["search"] })] })),
    )
    expect(result.status).toBe("paused")
    if (result.status !== "paused") throw new Error("unreachable")
    expect(result.interruptions.map((i) => i.kind === "approval" && i.toolCallId)).toEqual(["c2"])
    expect(executed).toEqual(["read_file:/a"])
    const logged = await all(log)
    expect(resultOf(logged, "c1").payload.isError).toBe(false)
    expect(resultOf(logged, "c2")).toBeUndefined()
    expect(resultOf(logged, "c3").payload.isError).toBe(true)
    expect(decisionsOf(logged).map((d) => d.payload.toolCallId)).toEqual(["c3"])
  })
})

describe("approval：validate 先于管线（R1）", () => {
  const ctx = stubCtx()
  const run = (
    c: PolicyCall,
    stages: Partial<{ deny: PolicyRule[]; ask: PolicyRule[]; allow: PolicyRule[] }> = {},
  ) =>
    evaluatePolicy(
      c,
      ctx,
      { deny: [], ask: [], allow: [], ...stages },
      { unmatched: "byRisk", maxSummaryChars: 200 },
    )
  const strict = defineTool<{ env: string }>({
    name: "deploy",
    description: "",
    inputSchema: { type: "object" },
    validate: (raw) => {
      const env = (raw as { env?: unknown }).env
      if (typeof env !== "string") throw new Error("env 必须是字符串")
      return { env: env.toLowerCase() }
    },
    needsApproval: (input) => input.env === "prod",
    risk: "high",
  }) as Tool

  it("规则、needsApproval、摘要看到的都是规范化后的入参", async () => {
    const seenByRule: unknown[] = []
    const rule: PolicyRule = {
      id: "trace",
      match: (c) => {
        seenByRule.push(c.args)
        return false
      },
    }
    const out = await run(
      { toolCallId: "c1", name: "deploy", args: { env: "PROD" }, tool: strict },
      { deny: [rule] },
    )
    expect(seenByRule).toEqual([{ env: "prod" }])
    expect(out).toEqual({
      verdict: "ask",
      policyId: BUILTIN_APPROVAL_POLICY,
      summary: 'deploy({"env":"prod"})',
    })
  })

  it("校验不过：不问人，以 approval.invalid_args 放行给循环拒掉", async () => {
    const out = await run({ toolCallId: "c1", name: "deploy", args: { env: 7 }, tool: strict })
    expect(out).toEqual({ verdict: "allow", policyId: "approval.invalid_args" })
  })
})
