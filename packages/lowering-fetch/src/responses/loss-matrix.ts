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
    exact("user", "input 里的 user 消息，input_text / input_image 块"),
    lossy(
      "user",
      "后移到同批工具结果之后（顺序有变）、不可信内容转义、或模型不接受图片而换成占位文本",
      "工具结果没到齐时用户插话 / 内容含 </untrusted / 带图片而模型不收图",
    ),
    dropped("none", "内容为空，不下发空消息", "用户消息没有任何非空内容"),
  ],
  "core.model_text": [
    exact(
      "assistant-message",
      "type:message 的 assistant 输出项，一轮多段各自成项；item id 同家回放、否则补一个",
    ),
    dropped("none", "空正文不下发", "text 为空串"),
  ],
  "core.model_thinking": [
    exact(
      "reasoning-item",
      "整个 reasoning 项（含 encrypted_content）原样回放",
      "replay.thinkingSignature 是带 encrypted_content 的 reasoning 项且来源同家（provider + api）",
    ),
    dropped(
      "none",
      "没有 encrypted_content（未开加密项 / 流中断）或来自别家的 reasoning 无法回放，不降成正文",
    ),
  ],
  "core.tool_call": [
    exact(
      "function_call",
      "arguments 是 JSON 字符串，非对象入参也原样序列化；fc_ 项 id 只在同一模型时回放（避开配对校验）",
    ),
  ],
  "core.tool_result": [
    exact(
      "function_call_output",
      "按 call_id 对应；文本 output 字符串，带图片时 output 为内容块数组；工具引用段展开成文本（Responses 无延迟加载落点）",
    ),
    lossy(
      "function_call_output",
      "isError 以 [tool error] 前缀表达（协议没有错误位），或不可信内容转义，或模型不接受图片而换成占位文本",
    ),
  ],
  "core.system_note": [
    exact(
      "developer",
      "input 里任意位置的 developer 消息",
      "推理模型（或 responses.systemRole = developer）",
    ),
    exact("system", "input 里任意位置的 system 消息", "非推理模型（或 responses.systemRole = system）"),
    lossy(
      "developer",
      "developer 消息，但不可信内容里的提前闭合被转义",
      "宿主标为 untrusted 的说明含 </untrusted",
    ),
    lossy("system", "system 消息，但不可信内容里的提前闭合被转义", "同上"),
    lossy(
      "user-role",
      "以 <system_note> 标签包住走 user 角色",
      "宿主对特殊上游声明 midConversationSystem: false",
    ),
  ],
  "core.compaction": [lossy("user-text", "摘要以 user 角色文本呈现，模型无法区分它与用户原话")],
  ...NOT_SENT,
}
