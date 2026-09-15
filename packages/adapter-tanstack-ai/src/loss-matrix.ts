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

const OPS = dropped("operational event, not sent (the default projection already filters it)")

export const TANSTACK_LOSS_MATRIX: Readonly<Record<string, readonly LossEntry[]>> = {
  "core.user_message": [
    exact("user"),
    lossy(
      "user",
      "a user message sitting between a tool_call and its tool_result is moved after that batch of results (tool results must immediately follow their call)",
    ),
  ],
  "core.model_text": [
    exact("assistant-text"),
    lossy("merged-text", "multiple text segments of one response are merged into a single string"),
  ],
  "core.model_thinking": [
    exact("thinking"),
    dropped("thinking with no signature or from another source is not sent (the provider would reject it)"),
  ],
  "core.tool_call": [exact("tool-call")],
  "core.tool_result": [
    exact("tool"),
    lossy(
      "tool-error-field",
      "isError lands only in ModelMessage.error; whether the model is told is up to the adapter",
    ),
  ],
  "core.system_note": [
    lossy(
      "user-role",
      "TanStack messages have no system role, so it is wrapped in a <system_note> tag and sent as user",
    ),
  ],
  "core.compaction": [lossy("user-text", "the summary is rendered as user-role text")],
  "core.approval_request": [OPS],
  "core.approval_decision": [OPS],
  "core.run_paused": [OPS],
  "core.run_resumed": [OPS],
  "core.budget_usage": [OPS],
  "core.memory_op": [OPS],
  "core.handoff": [OPS],
  "core.error": [OPS],
}
