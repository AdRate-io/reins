/**
 * 子代理即工具（技术方案 §10.1）：编排者的两个专家工具，用库里的 `asTool` 装。
 *
 * 手写版对照见 `subagent-tool.handwritten.ts`（P3 时的范式，逐条标号五件事）。两者对模型的形状一样（入参 `{ task }`、
 * 结果 JSON 带 childSessionId / status / answer / usage），差别在 asTool 多做对的两件事：
 * - 子 run 暂停等审批时，父 run 整体 paused 把审批带给宿主（手写版只能把 paused 当 isError 交给父模型）；
 * - 子 run 的 token 计入父 run 的预算，父的 budget 模块按总账拦（手写版只把用量写进结果给模型看）。
 */
import { type Agent, asTool, type SubagentOutcome, subagentOutcomesOf, type Tool } from "@reinsjs/agent"

export interface ExpertToolOptions {
  /** 模型看到的工具名，如 ask_analyst */
  name: string
  description: string
  /** 角色名，写进结果 JSON */
  role: string
  agent: Agent
  /** 中止传递：linked（缺省，父停子停）/ detached（接力，父中止时子做完为止） */
  abort?: "linked" | "detached"
  /** 缺省 low：专家只有只读工具。专家能改东西就提高，让父侧 approval 模块问人 */
  risk?: "low" | "medium" | "high"
}

export function expertTool(opts: ExpertToolOptions): Tool {
  const { agent, ...rest } = opts
  return asTool(agent, rest)
}

/** 父时间线里顺着 ask_* 的结果找子会话（回放 / 导出用） */
export const childSessionsOf = subagentOutcomesOf
export type ExpertOutcome = SubagentOutcome
