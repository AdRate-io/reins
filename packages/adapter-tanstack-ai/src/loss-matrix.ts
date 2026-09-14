/**
 * TanStack AI 路径的有损矩阵：每种事件在 `toModelMessages` 里可能的落点（P7：有损必须声明，测试断言实际落点必在其中）。
 * 与 lowering-pi 的 LossMatrix 同形（事件 type → 可能落点列表）。
 */
import type { LossKind } from "@reinsjs/core"

export interface LossEntry {
  kind: LossKind
  landing: string
  note?: string
}

const exact = (landing: string): LossEntry => ({ kind: "exact", landing })
const lossy = (landing: string, note: string): LossEntry => ({ kind: "lossy", landing, note })
const dropped = (note: string): LossEntry => ({ kind: "dropped", landing: "none", note })

const OPS = dropped("运维事件不下发（投影默认已过滤）")

export const TANSTACK_LOSS_MATRIX: Readonly<Record<string, readonly LossEntry[]>> = {
  "core.user_message": [
    exact("user"),
    lossy("user", "落在 tool_call 与 tool_result 之间的用户消息后移到同批结果之后（工具结果必须紧跟调用）"),
  ],
  "core.model_text": [exact("assistant-text"), lossy("merged-text", "同一响应的多段正文合成一个字符串")],
  "core.model_thinking": [exact("thinking"), dropped("无签名或来源不同的 thinking 不下发（厂商会拒收）")],
  "core.tool_call": [exact("tool-call")],
  "core.tool_result": [
    exact("tool"),
    lossy("tool-error-field", "isError 只落在 ModelMessage.error 字段，是否告知模型取决于适配器"),
  ],
  "core.system_note": [lossy("user-role", "TanStack 消息无 system 角色，以 <system_note> 标签包住走 user")],
  "core.compaction": [lossy("user-text", "摘要以 user 角色文本呈现")],
  "core.approval_request": [OPS],
  "core.approval_decision": [OPS],
  "core.run_paused": [OPS],
  "core.run_resumed": [OPS],
  "core.budget_usage": [OPS],
  "core.memory_op": [OPS],
  "core.handoff": [OPS],
  "core.error": [OPS],
}
