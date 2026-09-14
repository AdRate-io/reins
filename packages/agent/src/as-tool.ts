/**
 * asTool：把一个 Agent 包成另一个 Agent 工具表上的 Tool —— 子代理即工具（技术方案 §10.1）。
 *
 * 要不要叫这个专家、叫它做什么、结果信不信，都是父模型在判断（宪法一）；库不做编排器，只把"手写容易做错的两件事"做对：
 * - **审批冒泡**：子 run 暂停（审批 / 预算 / 中止）时不把状态当 isError 交给父模型，而是返回 `subagentPause`——父 run 不落这条
 *   tool_result、整体 paused，宿主拿到 `Interruption(kind=subagent)`，处理子的审批后续跑父 run；父续跑补齐这条 pending 调用时，
 *   本工具凭 childSessionId 续跑子 run。状态全部可序列化，换进程成立。
 * - **预算合算**：子 run 的每条 budget_usage 经 `ctx.spend` 计入父 run 的 tokensSpent，父的 budget 模块按总账拦。
 * 其余三件与手写范式（examples/team/subagent-tool.handwritten.ts）一致：中止传递由使用者自决（abort）、principal 原样下传、
 * childSessionId 写进结果 JSON（模型可见，回放顺着它找子会话）。
 *
 * 子会话 id 缺省 `${父 sessionId}:${toolCallId}`：确定性派生，续跑时不靠内存、不靠宿主传回就能找回子会话。
 * 子日志末条是 run_paused 即续跑（不带 input，宿主给子会话的结论从 `ctx.decisions` 原样下传，多层嵌套逐层传）；
 * 否则当这个专家的新一轮（带 input）——传自己的 `childSessionId` 就能跟同一个专家多轮对话。
 * 深度守卫仍靠工具表：专家 agent 的工具表里不放 asTool 类工具。
 */
import {
  type BudgetUsagePayload,
  createCoreRegistry,
  defineTool,
  type Event,
  type RunResult,
  readTimeline,
  subagentPause,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@reinsjs/core"
import type { Agent } from "./create-agent.js"

export interface SubagentTask {
  task: string
}

export interface AsToolOptions {
  /** 模型看到的工具名，如 ask_analyst */
  name: string
  description: string
  /** 角色名，写进结果 JSON 方便模型与回放辨认 */
  role?: string
  /**
   * 中止传递：linked（缺省）把父的 signal 传给子 run，父停子停；detached 不传，父中止时子做完为止（接力语义）。
   * 循环层保证正在执行的工具跑完、结果落进父日志，父才 paused(host)
   */
  abort?: "linked" | "detached"
  /** 缺省 low（专家只有只读工具）。专家能改东西就提高，让父侧 approval 模块问人 */
  risk?: "low" | "medium" | "high"
  /** 子会话 id；缺省 `${父 sessionId}:${toolCallId}`。返回已有会话即跟同一个专家继续多轮 */
  childSessionId?: (ctx: ToolContext, input: SubagentTask) => string
}

/** 子 run 的用量汇总（从子会话时间线算，含续跑之前的部分） */
export interface SubagentUsage {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  toolCalls: number
}

/** 写进父 tool_result 的 JSON（模型可见） */
export interface SubagentOutcome {
  role?: string
  childSessionId: string
  /** 只会是 done / handoff / error：paused 不落结果而是冒泡 */
  status: RunResult["status"]
  /** 子 run 最后一轮的文本（最后一次工具调用之后的 model_text 拼接） */
  answer?: string
  /** handoff 时的目标会话，error 时的错误 */
  detail?: string
  usage: SubagentUsage
}

export const SUBAGENT_TASK_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description:
        "What you want this expert to do, self-contained: the expert sees none of your conversation.",
    },
  },
  required: ["task"],
  additionalProperties: false,
}

/** 缺省子会话 id：父会话 + 这次调用，确定性派生 */
export function defaultChildSessionId(ctx: ToolContext): string {
  return `${ctx.sessionId}:${ctx.toolCallId}`
}

export function asTool(agent: Agent, opts: AsToolOptions): Tool {
  const abort = opts.abort ?? "linked"
  const registry = agent.definition.registry ?? createCoreRegistry()
  const log = agent.definition.log

  return defineTool<SubagentTask>({
    name: opts.name,
    description: opts.description,
    inputSchema: SUBAGENT_TASK_SCHEMA,
    risk: opts.risk ?? "low",
    validate(input) {
      const task = (input as { task?: unknown } | null)?.task
      if (typeof task !== "string" || task.trim() === "") throw new Error("task 必须是非空字符串")
      return { task }
    },
    async execute(input, ctx) {
      const childSessionId = (opts.childSessionId ?? defaultChildSessionId)(ctx, input)
      // 子日志末条是 run_paused → 这是父续跑补齐 pending：续跑子 run，不再追加 input
      const last = (await log.tail(childSessionId, 1))[0]
      const resuming = last?.type === "core.run_paused"

      const run = agent.run({
        sessionId: childSessionId,
        ...(resuming ? {} : { input: input.task }),
        // 宿主给别的会话的结论原样下传：子循环把 sessionId 等于自己的拿去校验并记事件，其余再转发给它的工具（多层嵌套）
        ...(ctx.decisions && ctx.decisions.length > 0 ? { decisions: ctx.decisions } : {}),
        ...(ctx.principal ? { principal: ctx.principal } : {}),
        ...(abort === "linked" && ctx.signal ? { signal: ctx.signal } : {}),
      })

      let answer: string[] = []
      let result: RunResult
      while (true) {
        const step = await run.next()
        if (step.done) {
          result = step.value
          break
        }
        const e = step.value
        switch (e.type) {
          case "core.budget_usage":
            // 预算合算：子的每次模型请求都记到父 run 的账上
            ctx.spend?.((e.payload as BudgetUsagePayload).tokens)
            break
          case "core.tool_call":
            answer = [] // 答案 = 最后一次工具调用之后的文本
            break
          case "core.model_text":
            answer.push((e.payload as { text: string }).text)
            break
        }
      }

      if (result.status === "paused") {
        // 审批冒泡：不落结果，父 run 整体暂停；宿主处理子的中断后续跑父，父补齐这条 pending 时本工具再进来续跑子
        return subagentPause({
          childSessionId,
          reason: result.reason,
          interruptions: result.interruptions,
          state: result.state,
        })
      }

      const outcome: SubagentOutcome = {
        ...(opts.role !== undefined ? { role: opts.role } : {}),
        childSessionId,
        status: result.status,
        usage: usageOf(await readTimeline(log, childSessionId, { registry })),
      }
      let isError = false
      switch (result.status) {
        case "done":
          outcome.answer = answer.join("\n")
          break
        case "handoff":
          outcome.answer = answer.join("\n")
          outcome.detail = `expert handed off to session ${result.toSessionId}; its work continues there`
          break
        case "error":
          isError = true
          outcome.detail = `expert failed: ${(result.error.payload as { message?: string }).message ?? "unknown error"}`
          break
      }
      const res: ToolResult = { content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }], isError }
      return res
    },
  })
}

/** 子会话时间线里的用量合计：每条 budget_usage 一次请求，tool_call 计工具次数 */
export function usageOf(timeline: readonly Event[]): SubagentUsage {
  const usage: SubagentUsage = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0 }
  for (const e of timeline) {
    if (e.type === "core.budget_usage") {
      const t = (e.payload as BudgetUsagePayload).tokens
      usage.requests += 1
      usage.input += t.input
      usage.output += t.output
      usage.cacheRead += t.cacheRead ?? 0
      usage.cacheWrite += t.cacheWrite ?? 0
    } else if (e.type === "core.tool_call") usage.toolCalls += 1
  }
  return usage
}

/** 父时间线里，凡 name 在 toolNames 里的 tool_result，其 JSON 里的 childSessionId —— 回放 / 导出用 */
export function subagentOutcomesOf(
  events: Iterable<{ type: string; payload: unknown }>,
  toolNames: ReadonlySet<string>,
): SubagentOutcome[] {
  const found: SubagentOutcome[] = []
  for (const e of events) {
    if (e.type !== "core.tool_result") continue
    const p = e.payload as { name: string; content: { type: string; text?: string }[] }
    if (!toolNames.has(p.name)) continue
    const text = p.content.find((c) => c.type === "text")?.text
    if (!text) continue
    try {
      const parsed = JSON.parse(text) as Partial<SubagentOutcome>
      if (typeof parsed.childSessionId === "string") found.push(parsed as SubagentOutcome)
    } catch {
      // 不是 asTool 写的结果（如入参校验失败的 isError 文本），跳过
    }
  }
  return found
}
