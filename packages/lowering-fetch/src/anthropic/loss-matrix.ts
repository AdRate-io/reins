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
      "后移到同批工具结果之后（顺序有变）、不可信内容转义、或模型不接受图片而换成占位文本",
      "工具结果没到齐时用户插话 / 内容含 </untrusted / 带图片而模型不收图",
    ),
    dropped("none", "内容为空，Anthropic 不接受空文本块", "用户消息没有任何非空内容"),
  ],
  "core.model_text": [
    exact("assistant-text", "assistant 的 text 块，一轮多段各自成块"),
    dropped("none", "空正文不下发（厂商不接受空文本块）", "text 为空串"),
  ],
  "core.model_thinking": [
    exact(
      "thinking-block",
      "带 signature 原样回放",
      "replay 有 thinkingSignature 且来源同家（provider + api）",
    ),
    exact("redacted-thinking", "redacted_thinking 以 data 原样回放", "replay.redacted 为真"),
    dropped("none", "无 signature（流中断）或来自别家的 thinking 厂商不接受，不回放；不降成正文"),
  ],
  "core.tool_call": [
    exact("tool_use"),
    lossy("wrapped-args", "非对象入参包成 { value }", "tool_call.args 不是对象"),
  ],
  "core.tool_result": [
    exact("tool_result", "紧跟 tool_use 所在 assistant 的下一条 user；is_error 原样"),
    lossy("tool_result", "不可信内容转义，或模型不接受图片而换成占位文本"),
  ],
  "core.system_note": [
    exact(
      "system",
      "带正文的中途 system 消息；放出位置是下一条 assistant 之前或收尾",
      "模型族支持中途 system（Fable 5.x / Mythos 5.x / Opus 5 / Opus 4.8，或宿主声明）",
    ),
    lossy(
      "system",
      "中途 system 消息，但不可信内容里的提前闭合被转义",
      "宿主标为 untrusted 的说明含 </untrusted",
    ),
    lossy(
      "user-role",
      "以 <system_note> 标签包住走 user 角色",
      "模型族不支持中途 system；或摆放规则不允许（前一条是 assistant / 说明是首条）",
    ),
  ],
  "core.compaction": [lossy("user-text", "摘要以 user 角色文本呈现，模型无法区分它与用户原话")],
  ...NOT_SENT,
}
