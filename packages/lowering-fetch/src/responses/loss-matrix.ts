/**
 * OpenAI Responses 的有损矩阵（P7：有损必声明）。每条实际落点必须命中其中一条，矩阵里不能有死条目（loss-matrix.test.ts）。
 * 与 lowering-pi 的 "openai-responses" 表逐格对照：能 exact 的一样（user / assistant-message / reasoning-item / function_call /
 * function_call_output / developer / system）。不同处三格——无加密项或别家的 reasoning 这里 dropped 而非 pi-ai 的
 * "降为正文 / 厂商看着办"、tool_call 入参不是对象也照发（arguments 本就是 JSON 字符串，不必包 { value }）、
 * tool_result 的 isError 以前缀表达（协议没有错误位）并按模型能力处置图片。
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

export const RESPONSES_LOSS_MATRIX: Readonly<Record<string, readonly LandingSpec[]>> = {
  "core.user_message": [
    exact("user", "a user message in input, as input_text / input_image blocks"),
    lossy(
      "user",
      "moved after that batch of tool results (the order changes), untrusted content escaped, or images replaced with placeholder text because the model takes none",
      "the user speaks up before all tool results are in / the content holds a </untrusted / it carries images the model does not take",
    ),
    dropped(
      "none",
      "the content is empty, so no empty message is sent",
      "the user message has no non-empty content",
    ),
  ],
  "core.model_text": [
    exact(
      "assistant-message",
      "a type:message assistant output item; each text segment of a turn becomes its own item; the item id is replayed when it comes from the same model, otherwise a new one is made up",
    ),
    dropped("none", "empty text is not sent", "the text is an empty string"),
  ],
  "core.model_thinking": [
    exact(
      "reasoning-item",
      "the whole reasoning item (including encrypted_content) is replayed verbatim",
      "replay.thinkingSignature is a reasoning item with encrypted_content and comes from the same source (provider + api + model)",
    ),
    dropped(
      "none",
      "reasoning with no encrypted_content (the encrypted item was not requested, or the stream broke), from another source, or from another model of the same family (encrypted reasoning is only valid for the model that produced it) cannot be replayed, and is not downgraded to text",
    ),
  ],
  "core.tool_call": [
    exact(
      "function_call",
      "arguments is a JSON string, and non-object arguments are serialized as they are; the fc_ item id is replayed only for the same model (to stay clear of the pairing check)",
    ),
  ],
  "core.tool_result": [
    exact(
      "function_call_output",
      "matched by call_id; output is a string for text, or an array of content blocks when images are present; tool reference parts are expanded into text (Responses has no deferred-loading landing)",
    ),
    lossy(
      "function_call_output",
      "isError is expressed with a [tool error] prefix (the protocol has no error flag), or untrusted content is escaped, or images are replaced with placeholder text because the model takes none",
    ),
  ],
  "core.system_note": [
    exact(
      "developer",
      "a developer message anywhere in input",
      "a reasoning model (or responses.systemRole = developer)",
    ),
    exact(
      "system",
      "a system message anywhere in input",
      "a non-reasoning model (or responses.systemRole = system)",
    ),
    lossy(
      "developer",
      "a developer message, with the early close inside untrusted content escaped",
      "a note the host marked untrusted holds a </untrusted",
    ),
    lossy(
      "system",
      "a system message, with the early close inside untrusted content escaped",
      "same as above",
    ),
    lossy(
      "user-role",
      "wrapped in a <system_note> tag and sent with the user role",
      "the host declared midConversationSystem: false for an unusual upstream",
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
