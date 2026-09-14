/**
 * approval —— 审批与权限模块（技术方案 §9.7，B7）。
 *
 * 循环本身只有一处兜底：工具声明 `needsApproval` 且没有 Socket 做主时转审批暂停（P1）。本模块把"谁可以不问就跑、
 * 谁要先问人、谁一律不许"做成宿主可配的 **Policy 管线**，在 `beforeTool` 里跑：
 *
 *   未知工具 → deny ｜ deny 段 → ask 段（规则，再看工具自己的 needsApproval）→ allow 段 → 三段都没命中按 `unmatched`
 *
 * 每段内首个命中的规则即定；段与段的先后就是"deny 不可被 allow 覆盖"的落点。三种结论怎么落到时间线：
 * - **deny**：emit 一条 `approval_decision(approved=false, by=规则 id, reason)`，再返回 `{ block }`，循环把留痕排在
 *   `tool_result(isError)` 之前 —— 谁拒的、为什么，日志里有据可查；模型看到的是带策略名的错误结果。
 * - **ask**：返回 `{ defer: { policyId, summary } }`，循环 append `approval_request` 并以 paused(approval) 返回，
 *   宿主批完用 `decisions` 续跑（T10）。宿主已批准的调用再次经过管线时 defer 会被循环略过、直接执行，deny 仍然生效。
 * - **allow**：返回 "proceed"，不留事件 —— 时间线里 tool_call → tool_result 已经是完整记录，每次放行都多记一条只会撑大日志。
 *
 * fail-closed：任何规则求值抛错、`needsApproval` 函数抛错，都按 deny 处理（by = 出错的规则 id），并经 `warn` 告警。
 *
 * 位置：管线跑在哪一步由 Socket 注册顺序决定。**建议放在 sockets 末尾**（至少放在会 rewrite 入参的钩子之后）：
 * 这样判定的是真正要执行的入参；前面的钩子只可能收紧（block / defer），不存在"钩子放行绕过策略"的路径。
 */
import {
  type BeforeToolDecision,
  BUILTIN_APPROVAL_POLICY,
  type MaybePromise,
  type Socket,
  type Tool,
  type ToolCallEvent,
  type ToolContext,
  type TurnContext,
} from "@reinsjs/core"
import { APPROVAL_RULES } from "./rules.js"

/** 规则看到的一次调用 */
export interface PolicyCall {
  toolCallId: string
  name: string
  /** 经前面钩子改写后的入参（循环保证后续钩子看到的是最终入参） */
  args: unknown
  /** 工具定义；未知工具为 undefined（管线在规则之前就拒了，规则里见不到） */
  tool: Tool | undefined
}

export interface PolicyRule {
  /** 策略标识：ask 时进 `approval_request.policyId`，deny 时进 `approval_decision.by` */
  id: string
  /** 是否命中。抛错按 fail-closed 记 deny */
  match(call: PolicyCall, ctx: TurnContext): MaybePromise<boolean>
  /** ask 时给审批人看的一句话摘要；缺省 `name(入参 JSON)`（按 maxSummaryChars 截断） */
  summary?(call: PolicyCall): string
  /** deny 时给模型的说明；缺省 "策略 <id> 不允许调用 <name>" */
  reason?: string
}

/** 规则的简写：字符串即工具名 glob（`*` 匹配任意字符），id 为 `name:<pattern>` */
export type PolicyRuleSpec = PolicyRule | string

export type PolicyVerdict = "deny" | "ask" | "allow"

export interface ApprovalOptions {
  /** 一律不许（首匹配即定） */
  deny?: readonly PolicyRuleSpec[]
  /** 先问人 */
  ask?: readonly PolicyRuleSpec[]
  /** 不问就跑 */
  allow?: readonly PolicyRuleSpec[]
  /**
   * 三段都没命中时怎么办。缺省 "byRisk"：按工具声明的 risk —— low → allow；medium / high / 未声明 → ask
   * （只读工具放行、写与副作用先问人，§14）。"ask" / "deny" 则一律如此。
   */
  unmatched?: "byRisk" | "ask" | "deny"
  /** 审批摘要里入参 JSON 的最大字符数，超出截断并加省略号。缺省 200 */
  maxSummaryChars?: number
  /** 规则提示：缺省内置英文文案；传字符串替换；false 则不碰系统提示 */
  rules?: string | false
  /** 策略求值异常（fail-closed 记 deny）的告警出口。缺省 console.warn */
  warn?: (message: string) => void
}

export const APPROVAL_SOCKET_NAME = "approval"
export const DEFAULT_MAX_SUMMARY_CHARS = 200

/** 管线自带结论的策略标识（进 approval_request.policyId / approval_decision.by） */
export const APPROVAL_POLICY_IDS = {
  /** 模型调了工具表里没有的工具 */
  unknownTool: "approval.unknown_tool",
  /** 三段都没命中、unmatched="deny" */
  unmatched: "approval.unmatched",
  /** 三段都没命中、按 risk 兜底：`approval.risk.<low|medium|high|undeclared>` */
  risk: (level: Tool["risk"]) => `approval.risk.${level ?? "undeclared"}`,
  /** 入参没过工具自己的 validate：不问人、放行给循环以"入参不合法"拒掉（执行不会发生） */
  invalidArgs: "approval.invalid_args",
} as const

/** 入参过工具的 validate 后的调用；校验抛错返回 undefined。没有 validate 的工具原样返回 */
function validatedCall(call: PolicyCall): PolicyCall | undefined {
  const tool = call.tool
  if (!tool?.validate) return call
  try {
    return { ...call, args: tool.validate(call.args) }
  } catch {
    return undefined
  }
}

/** 管线的一次结论（导出供测试与宿主自己的 Socket 复用） */
export type PolicyOutcome =
  | { verdict: "allow"; policyId: string }
  | { verdict: "ask"; policyId: string; summary: string }
  | { verdict: "deny"; policyId: string; reason: string }

/** 工具名 glob → 正则：只认 `*`，其余字符按字面匹配，整串匹配 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`)
}

/** 把简写规范成规则 */
export function normalizeRule(spec: PolicyRuleSpec): PolicyRule {
  if (typeof spec !== "string") return spec
  const re = globToRegExp(spec)
  return { id: `name:${spec}`, match: (call) => re.test(call.name) }
}

/** 缺省摘要：`name(入参 JSON)`，入参过长截断 */
export function defaultSummary(call: PolicyCall, maxChars: number): string {
  const json = JSON.stringify(call.args) ?? ""
  const clipped = json.length > maxChars ? `${json.slice(0, maxChars)}…` : json
  return `${call.name}(${clipped})`
}

interface Stages {
  deny: readonly PolicyRule[]
  ask: readonly PolicyRule[]
  allow: readonly PolicyRule[]
}

/**
 * 跑一遍管线，得到结论。纯函数（不碰时间线），便于单测与宿主在别处复用。
 * 任何规则抛错 → deny（fail-closed），by 为出错规则的 id，原因带上错误信息；出错会经 onError 通知一次。
 */
export async function evaluatePolicy(
  call: PolicyCall,
  ctx: TurnContext,
  stages: Stages,
  opts: {
    unmatched: NonNullable<ApprovalOptions["unmatched"]>
    maxSummaryChars: number
    onError?: (rule: string, err: unknown) => void
  },
): Promise<PolicyOutcome> {
  const summaryOf = (rule: PolicyRule | undefined) =>
    rule?.summary ? rule.summary(call) : defaultSummary(call, opts.maxSummaryChars)
  const denyBy = (rule: PolicyRule): PolicyOutcome => ({
    verdict: "deny",
    policyId: rule.id,
    reason: rule.reason ?? `策略 ${rule.id} 不允许调用 ${call.name}`,
  })
  const failClosed = (rule: string, err: unknown): PolicyOutcome => {
    opts.onError?.(rule, err)
    return {
      verdict: "deny",
      policyId: rule,
      reason: `策略 ${rule} 求值异常，按拒绝处理：${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!call.tool) {
    return { verdict: "deny", policyId: APPROVAL_POLICY_IDS.unknownTool, reason: `未知工具：${call.name}` }
  }

  // 入参先过工具自己的 validate（R1）：规则、needsApproval、审批摘要看到的都是将要执行的那份（校验 / 规范化之后）。
  // 校验不过就不问人 —— 循环随后会以"入参不合法"把这次调用拒掉，执行不会发生，先让审批人批一个必定失败的调用只是浪费
  const tool = call.tool
  const validated = validatedCall(call)
  if (!validated) return { verdict: "allow", policyId: APPROVAL_POLICY_IDS.invalidArgs }
  call = validated

  // 每段首匹配即定；某条规则抛错立刻 deny，不再往下看
  const firstMatch = async (
    rules: readonly PolicyRule[],
  ): Promise<PolicyRule | PolicyOutcome | undefined> => {
    for (const rule of rules) {
      try {
        if (await rule.match(call, ctx)) return rule
      } catch (err) {
        return failClosed(rule.id, err)
      }
    }
    return undefined
  }
  const isOutcome = (x: PolicyRule | PolicyOutcome | undefined): x is PolicyOutcome =>
    x !== undefined && "verdict" in x

  const denied = await firstMatch(stages.deny)
  if (isOutcome(denied)) return denied
  if (denied) return denyBy(denied)

  const asked = await firstMatch(stages.ask)
  if (isOutcome(asked)) return asked
  if (asked) return { verdict: "ask", policyId: asked.id, summary: summaryOf(asked) }

  // 工具自己声明的 needsApproval 视作 ask 段的最后一条规则；函数形态抛错同样 fail-closed
  if (tool.needsApproval !== undefined) {
    try {
      const need =
        typeof tool.needsApproval === "function"
          ? await tool.needsApproval(call.args, toolContextOf(call, ctx))
          : tool.needsApproval
      if (need) return { verdict: "ask", policyId: BUILTIN_APPROVAL_POLICY, summary: summaryOf(undefined) }
    } catch (err) {
      return failClosed(BUILTIN_APPROVAL_POLICY, err)
    }
  }

  const allowed = await firstMatch(stages.allow)
  if (isOutcome(allowed)) return allowed
  if (allowed) return { verdict: "allow", policyId: allowed.id }

  switch (opts.unmatched) {
    case "deny":
      return {
        verdict: "deny",
        policyId: APPROVAL_POLICY_IDS.unmatched,
        reason: `没有策略允许调用 ${call.name}`,
      }
    case "ask":
      return { verdict: "ask", policyId: APPROVAL_POLICY_IDS.unmatched, summary: summaryOf(undefined) }
    default: {
      const level = tool.risk
      const policyId = APPROVAL_POLICY_IDS.risk(level)
      return level === "low"
        ? { verdict: "allow", policyId }
        : { verdict: "ask", policyId, summary: summaryOf(undefined) }
    }
  }
}

/** needsApproval 函数要的 ToolContext：与循环执行工具时给的同形（TurnContext 里都有） */
function toolContextOf(call: PolicyCall, ctx: TurnContext): ToolContext {
  return {
    sessionId: ctx.session.id,
    toolCallId: call.toolCallId,
    ...(ctx.principal ? { principal: ctx.principal } : {}),
    log: ctx.log,
    ...(ctx.blobs ? { blobs: ctx.blobs } : {}),
    ...(ctx.memory ? { memory: ctx.memory } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    emit: ctx.emit,
  }
}

/** 审批模块：deny → ask → allow 管线 + 规则提示。建议放在 sockets 末尾 */
export function approval(options: ApprovalOptions = {}): Socket {
  const stages: Stages = {
    deny: (options.deny ?? []).map(normalizeRule),
    ask: (options.ask ?? []).map(normalizeRule),
    allow: (options.allow ?? []).map(normalizeRule),
  }
  const unmatched = options.unmatched ?? "byRisk"
  const maxSummaryChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const rules = options.rules === undefined ? APPROVAL_RULES : options.rules

  return {
    name: APPROVAL_SOCKET_NAME,
    ...(rules === false ? {} : { systemPrompt: rules }),

    async beforeTool(
      ctx: TurnContext,
      call: ToolCallEvent,
      tool: Tool | undefined,
    ): Promise<BeforeToolDecision> {
      const { toolCallId, name, args } = call.payload
      const outcome = await evaluatePolicy({ toolCallId, name, args, tool }, ctx, stages, {
        unmatched,
        maxSummaryChars,
        onError: (rule, err) =>
          warn(
            `[reins/approval] 策略 ${rule} 求值异常，已按拒绝处理（${name}）：${err instanceof Error ? err.message : String(err)}`,
          ),
      })
      switch (outcome.verdict) {
        case "allow":
          return "proceed"
        case "ask":
          return { defer: { policyId: outcome.policyId, summary: outcome.summary } }
        case "deny":
          ctx.emit({
            type: "core.approval_decision",
            actor: "system",
            parentId: call.id,
            payload: { toolCallId, approved: false, by: outcome.policyId, reason: outcome.reason },
          })
          return { block: outcome.reason }
      }
    },
  }
}
