/**
 * 按模型声明能力（技术方案 §11）。脑子模块只看这些布尔值，不看模型名。
 */
import type { LoweringCapabilities } from "@reinsjs/core"
import type { PiModel } from "./models.js"

/**
 * S1 核实：Anthropic 带正文的中途 system 消息支持 Fable 5.1/5、Mythos 5.1/5、Opus 5/4.8；Sonnet 5 及更早不支持。
 * 按 id 前缀匹配，带日期后缀的 id（如 claude-opus-5-20260301）也能命中。
 */
const ANTHROPIC_MID_SYSTEM = /^claude-(fable-5|mythos-5|opus-5|opus-4-8)(-|$)/

/** 调研核实：服务端 task budget 仅 Opus 5 与 Fable 5.1（DECISIONS 2026-09-08） */
const ANTHROPIC_TASK_BUDGET = /^claude-(opus-5|fable-5-1)(-|$)/

/**
 * OpenAI Responses 只在请求带 reasoningEffort / reasoningSummary 时才开启 reasoning 并返回
 * encrypted_content（pi-ai 0.85.1 buildParams）；否则 reasoning 关闭，没有可回放的东西。
 * 所以 thinkingReplay 在这家取决于请求选项，如实声明，脑子模块不必猜。
 */
function openaiReasoningRequested(requestOptions: Record<string, unknown>): boolean {
  return Boolean(requestOptions.reasoningEffort || requestOptions.reasoningSummary)
}

/** 宿主在 ModelDefinition 里声明的能力，覆盖按 id 的推断 */
export interface CapabilityOverrides {
  midConversationSystem?: boolean
}

export function capabilitiesOf(
  model: PiModel,
  requestOptions: Record<string, unknown> = {},
  overrides: CapabilityOverrides = {},
): LoweringCapabilities {
  const caps = inferCapabilities(model, requestOptions)
  return overrides.midConversationSystem === undefined
    ? caps
    : { ...caps, midConversationSystem: overrides.midConversationSystem }
}

function inferCapabilities(model: PiModel, requestOptions: Record<string, unknown>): LoweringCapabilities {
  const base = {
    api: model.api,
    thinkingReplay: model.reasoning,
    parallelTools: true,
    // pi-ai 的请求整形改不了，defer_loading / tool_reference 没有落点（L1）：引用段展开成文本、deferLoading 的工具不发
    deferredTools: false,
    images: model.input.includes("image"),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
  }
  switch (model.api) {
    case "anthropic-messages":
      return {
        ...base,
        midConversationSystem: ANTHROPIC_MID_SYSTEM.test(model.id),
        taskBudget: ANTHROPIC_TASK_BUDGET.test(model.id),
      }
    case "openai-responses":
      // Responses 的 input 项允许任意位置的 developer / system 消息
      return {
        ...base,
        thinkingReplay: model.reasoning && openaiReasoningRequested(requestOptions),
        midConversationSystem: true,
        taskBudget: false,
      }
    default:
      return { ...base, midConversationSystem: false, taskBudget: false }
  }
}
