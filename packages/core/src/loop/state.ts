/**
 * run 状态的序列化（§6）。状态只含引用；内容从 EventLog 重读。
 * 签名（HMAC）与恢复校验在 T10 加到这里。
 */
import type { Event } from "../events/base.js"
import type { CoreEvent } from "../events/core.js"
import type { ModelRef } from "../lowering/types.js"
import type { SerializedRunState, Tool, ToolCallEvent } from "./types.js"

/** 时间线里还没有 tool_result 的 tool_call，按 seq 升序。进程死亡、审批暂停、客户端工具都会留下它们 */
export function pendingToolCalls(timeline: readonly Event[]): ToolCallEvent[] {
  const answered = new Set<string>()
  for (const raw of timeline) {
    const e = raw as CoreEvent
    if (e.type === "core.tool_result") answered.add(e.payload.toolCallId)
  }
  const pending: ToolCallEvent[] = []
  for (const raw of timeline) {
    const e = raw as CoreEvent
    if (e.type === "core.tool_call" && !answered.has(e.payload.toolCallId)) pending.push(e)
  }
  return pending
}

/**
 * 配置摘要：模型、工具名集合、系统提示。恢复时若不一致，宿主至少能察觉"换了配置在续跑"。
 * 用 Web Crypto 的 SHA-256，核心包不引依赖。
 */
export async function computeConfigHash(input: {
  model: ModelRef
  tools: readonly Tool[]
  systemPrompt?: string
}): Promise<string> {
  const material = JSON.stringify({
    model: input.model,
    tools: input.tools.map((t) => t.name).sort(),
    systemPrompt: input.systemPrompt ?? null,
  })
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export function serializeRunState(input: {
  sessionId: string
  lastSeq: number
  pendingToolCallIds: readonly string[]
  configHash: string
}): SerializedRunState {
  return {
    v: 1,
    sessionId: input.sessionId,
    lastSeq: input.lastSeq,
    pendingToolCallIds: [...input.pendingToolCallIds],
    configHash: input.configHash,
  }
}
