/**
 * 有损矩阵（P7：有损必声明）。api → 事件 type → 可能落点。
 *
 * 这是"合同"：toRequest 对每条事件实际记录的落点必须是这里声明过的一种（T8 测试逐项断言）。
 * 新增事件类型或新 API 而不补这张表，测试就红 —— 宁可编译期/测试期吵，不要线上静默丢。
 */
import type { LandingSpec, LossMatrix } from "@reins/core"

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
  "core.approval_request": [dropped("none", "审批结果由 tool_result(isError) 告知模型")],
  "core.approval_decision": [dropped("none", "同上")],
  "core.run_paused": [dropped("none", "运行记录；感知模块会提炼进 system_note")],
  "core.run_resumed": [dropped("none", "同上")],
  "core.budget_usage": [dropped("none", "同上")],
  "core.memory_op": [dropped("none", "记忆读写留痕，模型已通过工具结果知晓")],
  "core.handoff": [dropped("none", "交接后本会话结束；新会话首条 user 承载 triggerMessage")],
  "core.error": [dropped("none", "provider 错误由循环处理；工具错误已在 tool_result.isError")],
}

const THINKING_COMMON = {
  noSignature: lossy(
    "text-or-drop",
    "无签名的 thinking 由 pi-ai 降为文本或丢弃",
    "事件 replay 缺 thinkingSignature",
  ),
  foreign: lossy(
    "provider-dependent",
    "来自其它模型的 thinking，厂商可能忽略或拒收",
    "replay 的 provider/api/model 与当前不同",
  ),
}

const TOOL_CALL_ARGS = lossy("wrapped-args", "非对象入参包成 { value }", "tool_call.args 不是对象")

/** 用户在工具结果回来之前插话（续跑带新 input、进程死亡后再发消息）：消息后移到同批结果之后，顺序有变 */
const USER_DEFERRED = lossy(
  "user",
  "落在 tool_call 与 tool_result 之间的用户消息后移到同批结果之后（工具结果必须紧跟调用）",
  "工具结果没到齐时用户插话",
)

export const LOSS_MATRIX: LossMatrix = {
  "anthropic-messages": {
    "core.user_message": [exact("user"), USER_DEFERRED],
    "core.model_text": [exact("assistant-text")],
    "core.model_thinking": [
      exact("thinking-block", "带 signature 原样回放"),
      THINKING_COMMON.noSignature,
      THINKING_COMMON.foreign,
    ],
    "core.tool_call": [exact("tool_use"), TOOL_CALL_ARGS],
    "core.tool_result": [exact("tool_result", "紧跟对应 tool_use 的下一条 user")],
    "core.system_note": [
      exact(
        "system",
        "带正文的中途 system 消息",
        "模型族支持中途 system（Fable 5.x / Mythos 5.x / Opus 5 / Opus 4.8）",
      ),
      lossy("user-role", "以 <system_note> 标签包住走 user 角色", "模型族不支持中途 system"),
    ],
    "core.compaction": [lossy("user-text", "摘要以 user 角色文本呈现，模型无法区分它与用户原话")],
    ...NOT_SENT,
    "ext.*": [dropped("none", "宿主扩展事件无通用落点；需要模型看见的应在投影层翻译成 core 事件")],
  },
  "openai-responses": {
    "core.user_message": [exact("user"), USER_DEFERRED],
    "core.model_text": [exact("assistant-message")],
    "core.model_thinking": [
      exact("reasoning-item", "encrypted_content 原样回放"),
      THINKING_COMMON.noSignature,
      THINKING_COMMON.foreign,
    ],
    "core.tool_call": [exact("function_call"), TOOL_CALL_ARGS],
    "core.tool_result": [exact("function_call_output")],
    "core.system_note": [
      exact("developer", "reasoning 模型用 developer 角色"),
      exact("system", "非 reasoning 模型用 system 角色"),
    ],
    "core.compaction": [lossy("user-text", "摘要以 user 角色文本呈现")],
    ...NOT_SENT,
    "ext.*": [dropped("none", "同 Anthropic")],
  },
}

/** 查某 api 下某事件 type 的声明落点；ext.* 归到通配项 */
export function declaredLandings(api: string, type: string): readonly LandingSpec[] {
  const table = LOSS_MATRIX[api]
  if (!table) return []
  return table[type] ?? (type.startsWith("ext.") ? (table["ext.*"] ?? []) : [])
}
