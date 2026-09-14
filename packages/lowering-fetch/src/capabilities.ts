/**
 * 按模型声明能力（技术方案 §11）。脑子模块只看这些布尔值，不看模型名。
 */
import type { LoweringCapabilities } from "@reinsjs/core"
import type { FetchModel } from "./models.js"

/**
 * S1 / F0 核实：Anthropic 带正文的中途 system 消息支持 Fable 5.x / Mythos 5.x / Opus 5 / Opus 4.8；Sonnet 5、Haiku 4.5 及更早
 * 回厂商原文 400。按 id 前缀匹配，带日期后缀的 id 也能命中；第三方 Anthropic 协议上游（如 DeepSeek 兼容端口）由宿主声明。
 */
const ANTHROPIC_MID_SYSTEM = /^claude-(fable-5|mythos-5|opus-5|opus-4-8)(-|$)/

/** 服务端 task budget 仅 Opus 5 与 Fable 5.1（DECISIONS 2026-09-08） */
const ANTHROPIC_TASK_BUDGET = /^claude-(opus-5|fable-5-1)(-|$)/

export function capabilitiesOf(model: FetchModel): LoweringCapabilities {
  const base = {
    api: model.api,
    parallelTools: true,
    images: model.images ?? false,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    taskBudget: false,
  }
  switch (model.api) {
    case "openai-chat":
      return {
        ...base,
        // Chat 的 system 消息可出现在任意位置（OpenAI 官方与 DeepSeek 实测到达），宿主可对特殊上游关掉
        midConversationSystem: model.midConversationSystem ?? true,
        // 官方 Chat 没有 thinking 回放位；只有 DeepSeek 方言的 reasoning_content 能把思考原样回填
        thinkingReplay: model.reasoning && model.chat?.reasoningContent === true,
      }
    case "anthropic-messages":
      return {
        ...base,
        midConversationSystem: model.midConversationSystem ?? ANTHROPIC_MID_SYSTEM.test(model.id),
        // 带 signature 的 thinking 块可原样回放（F0 A7b 实测接受、伪造签名 400）
        thinkingReplay: model.reasoning,
        taskBudget: ANTHROPIC_TASK_BUDGET.test(model.id),
      }
    default:
      return { ...base, midConversationSystem: model.midConversationSystem ?? false, thinkingReplay: false }
  }
}
