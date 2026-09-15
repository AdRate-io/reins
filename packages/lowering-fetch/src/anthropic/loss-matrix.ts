/**
 * Anthropic Messages 的有损矩阵（P7：有损必声明）。每条实际落点必须命中其中一条，矩阵里不能有死条目（loss-matrix.test.ts）。
 * 与 lowering-pi 的 "anthropic-messages" 表逐格对照：能 exact 的一样（user / assistant-text / tool_use / tool_result /
 * thinking-block / system），不同处只有三格——无签名 thinking 这里 dropped 而非 pi-ai 的"降为正文"、redacted 单列、
 * tool_result 图片按模型能力处置。
 */
import type { LandingSpec } from "@reinsjs/core"
import { NOT_SENT } from "../chat/loss-matrix.js"

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

export const ANTHROPIC_LOSS_MATRIX: Readonly<Record<string, readonly LandingSpec[]>> = {
  "core.user_message": [
    exact("user"),
    lossy(
      "user",
      "moved after that batch of tool results (the order changes), untrusted content escaped, or images replaced with placeholder text because the model takes none",
      "the user speaks up before all tool results are in / the content holds a </untrusted / it carries images the model does not take",
    ),
    dropped(
      "none",
      "the content is empty and Anthropic rejects empty text blocks",
      "the user message has no non-empty content",
    ),
  ],
  "core.model_text": [
    exact(
      "assistant-text",
      "a text block on the assistant; each text segment of a turn becomes its own block",
    ),
    dropped(
      "none",
      "empty text is not sent (the provider rejects empty text blocks)",
      "the text is an empty string",
    ),
  ],
  "core.model_thinking": [
    exact(
      "thinking-block",
      "replayed verbatim with its signature",
      "the replay has a thinkingSignature and comes from the same source (provider + api + model)",
    ),
    exact(
      "redacted-thinking",
      "redacted_thinking is replayed verbatim through its data",
      "replay.redacted is true",
    ),
    dropped(
      "none",
      "thinking with no signature (a broken stream), from another family, or from another model of the same family (a signature is only valid for the model that produced it) is rejected by the provider, so it is not replayed, and not downgraded to text either",
    ),
  ],
  "core.tool_call": [
    exact("tool_use"),
    lossy("wrapped-args", "non-object arguments are wrapped as { value }", "tool_call.args is not an object"),
  ],
  "core.tool_result": [
    exact(
      "tool_result",
      "in the user message right after the assistant that holds the tool_use; is_error is passed through; tool reference parts are expanded into text when the native capability is missing or the result is not trusted as system",
    ),
    lossy(
      "tool_result",
      "untrusted content is escaped, or images are replaced with placeholder text because the model takes none, or the referenced tool is absent from this request's tool table and its definition is expanded into text",
    ),
    exact(
      "tool-reference",
      "the result holds nothing but tool reference parts: a tool_reference block goes into the tool_result and the provider expands it in place into the full definition (the tool table stays byte-identical)",
      "the model supports defer_loading, the result is trusted as system, and every referenced tool is in this request's tool table",
    ),
    lossy(
      "tool-reference",
      "the reference block goes into the tool_result and the result's text segments move to a text block right after it in the same user message (a reference inside a tool_result cannot be mixed with text)",
      "the result holds both reference parts and text segments (explanatory text, untrusted markers)",
    ),
  ],
  "core.system_note": [
    exact(
      "system",
      "a mid-conversation system message carrying the text; it is placed before the next assistant message, or at the very end",
      "the model family supports mid-conversation system (Fable 5.x / Mythos 5.x / Opus 5 / Opus 4.8, or the host says so)",
    ),
    lossy(
      "system",
      "a mid-conversation system message, with the early close inside untrusted content escaped",
      "a note the host marked untrusted holds a </untrusted",
    ),
    lossy(
      "user-role",
      "wrapped in a <system_note> tag and sent with the user role",
      "the model family does not support mid-conversation system, or the placement rules forbid it (the previous message is an assistant, or the note would be first)",
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
