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
  "core.approval_request": [dropped("none", "审批结果由 tool_result(isError) 告知模型")],
  "core.approval_decision": [dropped("none", "同上")],
  "core.run_paused": [dropped("none", "运行记录；感知模块会提炼进 system_note")],
  "core.run_resumed": [dropped("none", "同上")],
  "core.budget_usage": [dropped("none", "同上")],
  "core.memory_op": [dropped("none", "记忆读写留痕，模型已通过工具结果知晓")],
  "core.handoff": [dropped("none", "交接后本会话结束；新会话首条 user 承载 triggerMessage")],
  "core.tools_bound": [dropped("none", "工具表快照；工具表变化由循环另发 system_note 告知")],
  "core.error": [dropped("none", "provider 错误由循环处理；工具错误已在 tool_result.isError")],
  "ext.*": [dropped("none", "宿主扩展事件无通用落点；需要模型看见的应在投影层翻译成 core 事件")],
}

export const CHAT_LOSS_MATRIX: Readonly<Record<string, readonly LandingSpec[]>> = {
  "core.user_message": [
    exact("user"),
    lossy(
      "user",
      "后移到同批工具结果之后（顺序有变）、不可信内容转义、或模型不接受图片而换成占位文本",
      "工具结果没到齐时用户插话 / 内容含 </untrusted / 带图片而模型不收图",
    ),
  ],
  "core.model_text": [
    exact("assistant-content"),
    lossy(
      "merged-text",
      "同一轮多段正文合并成一个字符串（assistant.content 只能是 string）",
      "一轮里不止一段正文",
    ),
  ],
  "core.model_thinking": [
    exact(
      "reasoning_content",
      "DeepSeek 方言：思考正文原样回填",
      "模型开了 chat.reasoningContent 且来源同家",
    ),
    dropped("none", "Chat Completions 没有 thinking 回放位（无签名、无加密项），或来源是别家"),
  ],
  "core.tool_call": [exact("tool_calls", "arguments 为 JSON 字符串")],
  "core.tool_result": [
    exact("tool", "role:tool 消息，紧跟带 tool_calls 的 assistant"),
    lossy("tool", "isError 以 [tool error] 前缀表达（tool 消息没有错误位），或不可信内容转义"),
    lossy("tool-text-only", "tool 消息只收文本，图片换成占位文本", "结果里有图片"),
  ],
  "core.system_note": [
    exact("system", "中途 system 消息", "上游接受中途 system（缺省）"),
    lossy(
      "system",
      "中途 system 消息，但不可信内容里的提前闭合被转义",
      "宿主标为 untrusted 的说明含 </untrusted",
    ),
    lossy("user-role", "以 <system_note> 标签包住走 user 角色", "模型声明 midConversationSystem: false"),
  ],
  "core.compaction": [lossy("user-text", "摘要以 user 角色文本呈现，模型无法区分它与用户原话")],
  ...NOT_SENT,
}
