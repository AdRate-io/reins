/**
 * 有损矩阵（P7：有损必声明）。api → 事件 type → 可能落点。
 *
 * 这是"合同"：toRequest 对每条事件实际记录的落点必须是这里声明过的一种（T8 测试逐项断言）。
 * 新增事件类型或新 API 而不补这张表，测试就红 —— 宁可编译期/测试期吵，不要线上静默丢。
 */
import type { LandingSpec, LossMatrix } from "@reinsjs/core"

const exact = (landing: string, note?: string, when?: string): LandingSpec => {
  const spec: LandingSpec = { kind: "exact", landing }
  if (note) spec.note = note
  if (when) spec.when = when
  return spec
}
const lossy = (landing: string, note: string, when?: string): LandingSpec =>
  when ? { kind: "lossy", landing, note, when } : { kind: "lossy", landing, note }
const dropped = (landing: string, note: string): LandingSpec => ({ kind: "dropped", landing, note })

/** 两家共同的"不下发"事件：它们服务宿主与审计，信息由别的事件承载；投影默认已过滤，这里是第二道声明 */
const NOT_SENT: Readonly<Record<string, readonly LandingSpec[]>> = {
  "core.approval_request": [
    dropped("none", "the approval outcome reaches the model through tool_result(isError)"),
  ],
  "core.approval_decision": [dropped("none", "same as above")],
  "core.run_paused": [dropped("none", "a run record; the perception module distills it into a system_note")],
  "core.run_resumed": [dropped("none", "same as above")],
  "core.budget_usage": [dropped("none", "same as above")],
  "core.memory_op": [
    dropped(
      "none",
      "an audit trail of memory reads and writes; the model already learned of them from the tool result",
    ),
  ],
  "core.handoff": [
    dropped(
      "none",
      "this session ends at the handoff; the new session's first user message carries the triggerMessage",
    ),
  ],
  "core.error": [
    dropped(
      "none",
      "provider errors are handled by the loop; tool errors already live in tool_result.isError",
    ),
  ],
}

const THINKING_COMMON = {
  noSignature: lossy(
    "text-or-drop",
    "pi-ai downgrades unsigned thinking to text or drops it",
    "the event's replay has no thinkingSignature",
  ),
  foreign: lossy(
    "provider-dependent",
    "thinking from another model, which the provider may ignore or reject",
    "the replay's provider/api/model differs from the current one",
  ),
}

const TOOL_CALL_ARGS = lossy(
  "wrapped-args",
  "non-object arguments are wrapped as { value }",
  "tool_call.args is not an object",
)

/** 用户在工具结果回来之前插话（续跑带新 input、进程死亡后再发消息）：消息后移到同批结果之后，顺序有变 */
const USER_DEFERRED = lossy(
  "user",
  "a user message sitting between a tool_call and its tool_result is moved after that batch of results (tool results must immediately follow their call)",
  "the user speaks up before all tool results are in",
)

export const LOSS_MATRIX: LossMatrix = {
  "anthropic-messages": {
    "core.user_message": [exact("user"), USER_DEFERRED],
    "core.model_text": [exact("assistant-text")],
    "core.model_thinking": [
      exact("thinking-block", "replayed verbatim with its signature"),
      THINKING_COMMON.noSignature,
      THINKING_COMMON.foreign,
    ],
    "core.tool_call": [exact("tool_use"), TOOL_CALL_ARGS],
    "core.tool_result": [exact("tool_result", "in the user message right after the matching tool_use")],
    "core.system_note": [
      exact(
        "system",
        "a mid-conversation system message carrying the text",
        "the model family supports mid-conversation system (Fable 5.x / Mythos 5.x / Opus 5 / Opus 4.8)",
      ),
      lossy(
        "user-role",
        "wrapped in a <system_note> tag and sent with the user role",
        "the model family does not support mid-conversation system",
      ),
    ],
    "core.compaction": [
      lossy(
        "user-text",
        "the summary is rendered as user-role text, so the model cannot tell it apart from the user's own words",
      ),
    ],
    ...NOT_SENT,
    "ext.*": [
      dropped(
        "none",
        "host extension events have no general landing; translate the ones the model must see into core events in the projection layer",
      ),
    ],
  },
  "openai-responses": {
    "core.user_message": [exact("user"), USER_DEFERRED],
    "core.model_text": [exact("assistant-message")],
    "core.model_thinking": [
      exact("reasoning-item", "the encrypted_content is replayed verbatim"),
      THINKING_COMMON.noSignature,
      THINKING_COMMON.foreign,
    ],
    "core.tool_call": [exact("function_call"), TOOL_CALL_ARGS],
    "core.tool_result": [exact("function_call_output")],
    "core.system_note": [
      exact("developer", "reasoning models take the developer role"),
      exact("system", "non-reasoning models take the system role"),
    ],
    "core.compaction": [lossy("user-text", "the summary is rendered as user-role text")],
    ...NOT_SENT,
    "ext.*": [dropped("none", "same as Anthropic")],
  },
}

/** 查某 api 下某事件 type 的声明落点；ext.* 归到通配项 */
export function declaredLandings(api: string, type: string): readonly LandingSpec[] {
  const table = LOSS_MATRIX[api]
  if (!table) return []
  return table[type] ?? (type.startsWith("ext.") ? (table["ext.*"] ?? []) : [])
}
