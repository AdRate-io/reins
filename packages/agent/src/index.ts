/**
 * reins —— 总包。装上、配自己的模型，就得到一辆有驾驭经验的车（PRD §5.1）：
 *
 *   import { createAgent, memoryStore } from "@reinsjs/agent"
 *   import { anthropic } from "@reinsjs/lowering-pi"
 *   const agent = createAgent({ model: anthropic("claude-opus-5", { apiKey }), tools, store: memoryStore() })
 *   export const POST = agent.handler
 *
 * 本包只做一件事：createAgent。其余全部原样再导出 @reinsjs/core、@reinsjs/server、@reinsjs/ui-agui，
 * 用户装一个包就够；降级层（@reinsjs/lowering-pi，带 pi-ai 依赖）单独装，换别的降级层实现不必带着它。
 */
export * from "@reinsjs/core"
export * from "@reinsjs/server"
export * from "@reinsjs/ui-agui"
export {
  type AsToolOptions,
  asTool,
  defaultChildSessionId,
  SUBAGENT_TASK_SCHEMA,
  type SubagentOutcome,
  type SubagentTask,
  type SubagentUsage,
  subagentOutcomesOf,
  usageOf,
} from "./as-tool.js"
export { type Agent, type CreateAgentOptions, createAgent, type RunOptions } from "./create-agent.js"
