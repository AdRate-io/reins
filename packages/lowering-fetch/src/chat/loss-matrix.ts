/**
 * Chat Completions 的有损矩阵（P7：有损必声明）。事件 type → 可能落点；toRequest 记录的每条实际落点必须命中其中一条，
 * 矩阵里不能有从未命中的死条目（loss-matrix.test.ts）。新增事件类型或改落点不补表，测试就红。
 */
import type { LandingSpec } from "@reinsjs/core"

const exact = (landing: string, note?: string, when?: string): LandingSpec => {
  const spec: LandingSpec = { kind: "exact", landing }
  if (note) spec.note = note
  if (when) spec.when = when
  return spec
}
const lossy = (landing: string, note: string, when?: string): LandingSpec =>
  when ? { kind: "lossy", landing, note, when } : { kind: "lossy", landing, note }
const dropped = (landing: string, note: string, when?: string): LandingSpec =>
  when ? { kind: "dropped", landing, note, when } : { kind: "dropped", landing, note }

/** 不下发的运维事件：服务宿主与审计，信息由别的事件承载；投影默认已过滤，这里是第二道声明 */
export const NOT_SENT: Readonly<Record<string, readonly LandingSpec[]>> = {
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
  "core.tools_bound": [
    dropped(
      "none",
      "a snapshot of the tool table; the loop announces changes to it in a separate system_note",
    ),
  ],
  "core.error": [
    dropped(
      "none",
      "provider errors are handled by the loop; tool errors already live in tool_result.isError",
    ),
  ],
  "ext.*": [
    dropped(
      "none",
      "host extension events have no general landing; translate the ones the model must see into core events in the projection layer",
    ),
  ],
}

export const CHAT_LOSS_MATRIX: Readonly<Record<string, readonly LandingSpec[]>> = {
  "core.user_message": [
    exact("user"),
    lossy(
      "user",
      "moved after that batch of tool results (the order changes), untrusted content escaped, or images replaced with placeholder text because the model takes none",
      "the user speaks up before all tool results are in / the content holds a </untrusted / it carries images the model does not take",
    ),
  ],
  "core.model_text": [
    exact("assistant-content"),
    lossy(
      "merged-text",
      "multiple text segments of one turn are merged into a single string (assistant.content can only be a string)",
      "the turn holds more than one text segment",
    ),
  ],
  "core.model_thinking": [
    exact(
      "reasoning_content",
      "the DeepSeek dialect: the thinking text is filled back in verbatim",
      "the model has chat.reasoningContent on and the source is the same family",
    ),
    dropped(
      "none",
      "Chat Completions has no landing for replaying thinking (no signature, no encrypted item), or the source is another family",
    ),
  ],
  "core.tool_call": [exact("tool_calls", "arguments is a JSON string")],
  "core.tool_result": [
    exact(
      "tool",
      "a role:tool message right after the assistant that carries the tool_calls; tool reference parts are expanded into text (Chat has no deferred-loading landing)",
    ),
    lossy(
      "tool",
      "isError is expressed with a [tool error] prefix (a tool message has no error flag), or untrusted content is escaped",
    ),
    lossy(
      "tool-text-only",
      "a tool message takes text only, so images are replaced with placeholder text",
      "the result carries images",
    ),
  ],
  "core.system_note": [
    exact(
      "system",
      "a mid-conversation system message",
      "the upstream accepts mid-conversation system (the default)",
    ),
    lossy(
      "system",
      "a mid-conversation system message, with the early close inside untrusted content escaped",
      "a note the host marked untrusted holds a </untrusted",
    ),
    lossy(
      "user-role",
      "wrapped in a <system_note> tag and sent with the user role",
      "the model declares midConversationSystem: false",
    ),
  ],
  "core.compaction": [
    lossy(
      "user-text",
      "the summary is rendered as user-role text, so the model cannot tell it apart from the user's own words",
    ),
  ],
  ...NOT_SENT,
}
