/**
 * 子代理即工具（技术方案 §10.1，P3 手写范式）—— **对照版**：示例实际用的是 `subagent-tool.ts` 里基于库 `asTool` 的版本。
 * 保留这份是为了看清"手写要做对的五件事"各落在哪一行，以及 asTool 替手写多做对的两件事（⑤ 审批冒泡、④ 预算合算）。
 *
 * 一个专家 agent 暴露成编排者工具表上的一个 `Tool`：编排者的模型决定要不要叫它、叫它做什么、结果信不信 ——
 * 决策权在模型（宪法一），库不做编排器。这个文件就是"手写一个这样的工具要做对的五件事"，逐条标号：
 *
 *   ① 中止传递由使用者自决：`abort: "linked"`（缺省，父停子停，省钱）把 ctx.signal 传给子 run；
 *      `abort: "detached"`（接力语义，如"分析做完必须交给文案写完"）不传，父中止时子做完为止 ——
 *      循环层保证正在执行的工具会跑完、结果落进父日志，父才 paused(host)。
 *   ② 身份传递：principal 原样下传，子会话的鉴权、记忆前缀（`namespace: (ctx) => .../users/${ctx.principal.id}`）才对得上。
 *   ③ 时间线关联：子会话 sessionId 写进父 tool_result 的 JSON 里（模型可见，回放与 eval 顺着它找到子会话）。
 *   ④ 预算合算：子 run 的 budget_usage 记在子会话里，父的 budget 模块看不见；这里把子用量汇总写进父结果（已知缺口，0.2 的 asTool 助手做合算）。
 *   ⑤ 审批：子 run 返回 paused（审批 / 预算 / 中止）时，本工具**不**替人做主、不自己循环批 ——
 *      以 isError 把状态与原因交给父模型决定（重试、换任务、告诉用户）。信任边界收在父工具表上：专家自己不装 approval 模块，
 *      专家的每个工具调用都算"父的一次 ask_*"调用；专家带破坏性工具时请把本工具的 risk 提到 high 让父侧审批。
 *
 * 深度守卫：ctx 带不到调用深度，用工具表约束 —— 专家 agent 的工具表里不放 expertTool 类工具（见 agents.ts）。
 * 每次调用一个全新的子会话；要跟同一个专家多轮对话，把 childSessionId 回传成 sessionId 即可（本示例不做）。
 */
import { type Agent, type BudgetUsagePayload, defineTool, type RunResult, type Tool, type ToolResult } from "reins"

export interface ExpertToolOptions {
  /** 模型看到的工具名，如 ask_analyst */
  name: string
  description: string
  /** 角色名，写进结果 JSON */
  role: string
  agent: Agent
  /** ① 缺省 linked */
  abort?: "linked" | "detached"
  /** 缺省 low：专家只有只读工具。专家能改东西就提高，让父侧 approval 模块问人 */
  risk?: "low" | "medium" | "high"
}

/** ④ 子 run 的用量汇总 */
export interface ChildUsage {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  toolCalls: number
}

/** ③ 写进父 tool_result 的 JSON（模型可见） */
export interface ExpertOutcome {
  role: string
  childSessionId: string
  status: RunResult["status"]
  /** 子 run 最后一轮的文本（最后一次工具调用之后的 model_text 拼接） */
  answer?: string
  /** paused 时的原因，handoff 时的目标会话，error 时的错误 */
  detail?: string
  usage: ChildUsage
}

export const EXPERT_TASK_SCHEMA = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description: "What you want this expert to do, self-contained: the expert sees none of your conversation.",
    },
  },
  required: ["task"],
  additionalProperties: false,
} as const

export function expertTool(opts: ExpertToolOptions): Tool {
  const abort = opts.abort ?? "linked"
  return defineTool<{ task: string }>({
    name: opts.name,
    description: opts.description,
    inputSchema: EXPERT_TASK_SCHEMA as unknown as Record<string, unknown>,
    risk: opts.risk ?? "low",
    validate(input) {
      const task = (input as { task?: unknown } | null)?.task
      if (typeof task !== "string" || task.trim() === "") throw new Error("task 必须是非空字符串")
      return { task }
    },
    async execute({ task }, ctx): Promise<ToolResult> {
      const run = opts.agent.run({
        input: task,
        // ② 身份下传
        ...(ctx.principal ? { principal: ctx.principal } : {}),
        // ① linked 才把父的 signal 传给子
        ...(abort === "linked" && ctx.signal ? { signal: ctx.signal } : {}),
      })

      const usage: ChildUsage = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0 }
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
          case "core.budget_usage": {
            // ④ 子会话里的用量事件，父看不见，这里合计
            const u = e.payload as BudgetUsagePayload
            usage.requests += 1
            usage.input += u.tokens.input
            usage.output += u.tokens.output
            usage.cacheRead += u.tokens.cacheRead ?? 0
            usage.cacheWrite += u.tokens.cacheWrite ?? 0
            break
          }
          case "core.tool_call":
            usage.toolCalls += 1
            answer = [] // 答案 = 最后一次工具调用之后的文本
            break
          case "core.model_text":
            answer.push((e.payload as { text: string }).text)
            break
        }
      }

      // ③ childSessionId 一定在结果里，无论成败
      const outcome: ExpertOutcome = { role: opts.role, childSessionId: result.sessionId, status: result.status, usage }
      let isError = false
      switch (result.status) {
        case "done":
          outcome.answer = answer.join("\n")
          break
        case "handoff":
          // 专家自己切了会话：结果在新会话里继续，父这里只知道去哪找
          outcome.answer = answer.join("\n")
          outcome.detail = `expert handed off to session ${result.toSessionId}; its work continues there`
          break
        case "paused":
          // ⑤ 不替人批、不替模型决定：如实告知，让父模型定夺
          isError = true
          outcome.detail =
            result.reason === "approval"
              ? `expert stopped: a tool call needs human approval (${result.interruptions.length} pending). It was not resumed. Decide: retry with a narrower task, or report this to the user.`
              : result.reason === "budget"
                ? "expert stopped: budget exhausted before finishing. Its partial work is in its session; narrow the task or report."
                : "expert stopped: the run was aborted by the host."
          break
        case "error":
          isError = true
          outcome.detail = `expert failed: ${(result.error.payload as { message?: string }).message ?? "unknown error"}`
          break
      }
      return { content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }], isError }
    },
  })
}

/** 父时间线里，凡 name 在 expertToolNames 里的 tool_result，其 JSON 里的 childSessionId —— 回放 / 导出用 */
export function childSessionsOf(
  events: Iterable<{ type: string; payload: unknown }>,
  expertToolNames: ReadonlySet<string>,
): ExpertOutcome[] {
  const found: ExpertOutcome[] = []
  for (const e of events) {
    if (e.type !== "core.tool_result") continue
    const p = e.payload as { name: string; content: { type: string; text?: string }[] }
    if (!expertToolNames.has(p.name)) continue
    const text = p.content.find((c) => c.type === "text")?.text
    if (!text) continue
    try {
      const parsed = JSON.parse(text) as Partial<ExpertOutcome>
      if (typeof parsed.childSessionId === "string") found.push(parsed as ExpertOutcome)
    } catch {
      // 不是本范式写的结果（如入参校验失败的 isError 文本），跳过
    }
  }
  return found
}
