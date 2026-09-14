/**
 * 按模型声明能力（技术方案 §11）。脑子模块只看这些布尔值，不看模型名。
 */
import type { LoweringCapabilities } from "@reinsjs/core"
import type { FetchModel } from "./models.js"

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
    default:
      return { ...base, midConversationSystem: model.midConversationSystem ?? false, thinkingReplay: false }
  }
}
