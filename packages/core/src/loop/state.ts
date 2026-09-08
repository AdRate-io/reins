/**
 * run 状态的序列化、签名与恢复校验（§6，T9 / T10）。
 *
 * 状态只含引用：会话、最后 seq、pending 工具调用 ID、配置摘要、pending 入参摘要；内容全部从 EventLog 重读。
 * 签名用 Web Crypto 的 HMAC-SHA256，密钥由宿主提供；恢复时先校验签名，再把状态与日志对账 ——
 * 任何一处不一致都拒绝（fail-closed），且拒绝发生在写日志之前。
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

const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function sha256(material: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(material)))
}

/** 配置摘要：模型、工具名集合、系统提示。恢复时若不一致，说明"换了配置在续跑" */
export async function computeConfigHash(input: {
  model: ModelRef
  tools: readonly Tool[]
  systemPrompt?: string
}): Promise<string> {
  return sha256(
    JSON.stringify({
      model: input.model,
      tools: input.tools.map((t) => t.name).sort(),
      systemPrompt: input.systemPrompt ?? null,
    }),
  )
}

/** pending 调用的入参摘要：恢复时重算比对，保证批下去的就是当时看到的那次调用 */
export async function computePendingDigest(calls: readonly ToolCallEvent[]): Promise<string> {
  return sha256(
    JSON.stringify(calls.map((c) => [c.payload.toolCallId, c.payload.name, c.payload.args ?? null])),
  )
}

export async function serializeRunState(input: {
  sessionId: string
  lastSeq: number
  pending: readonly ToolCallEvent[]
  configHash: string
  secret?: string
}): Promise<SerializedRunState> {
  const state: SerializedRunState = {
    v: 1,
    sessionId: input.sessionId,
    lastSeq: input.lastSeq,
    pendingToolCallIds: input.pending.map((c) => c.payload.toolCallId),
    configHash: input.configHash,
    pendingDigest: await computePendingDigest(input.pending),
  }
  return input.secret === undefined ? state : signRunState(state, input.secret)
}

// ---- 签名 ----

/** 签名材料：除 sig 外的全部字段，键序固定 */
function signingMaterial(state: SerializedRunState): string {
  return JSON.stringify([
    state.v,
    state.sessionId,
    state.lastSeq,
    state.pendingToolCallIds,
    state.configHash,
    state.pendingDigest,
  ])
}

async function hmac(secret: string, material: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(material)))
}

export async function signRunState(state: SerializedRunState, secret: string): Promise<SerializedRunState> {
  const { sig: _drop, ...unsigned } = state
  return { ...unsigned, sig: await hmac(secret, signingMaterial(unsigned)) }
}

/** 常数时间比较，避免按字节短路泄露签名前缀 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function verifyRunState(state: SerializedRunState, secret: string): Promise<boolean> {
  if (typeof state.sig !== "string") return false
  const expected = await hmac(secret, signingMaterial(state))
  return timingSafeEqual(expected, state.sig)
}

// ---- 恢复校验 ----

export type RunStateErrorCode =
  | "malformed" // 不是 v1 状态的形状
  | "session_mismatch" // 状态属于别的会话
  | "missing_signature" // 配置了密钥但状态没签名
  | "bad_signature" // 签名不匹配：被改过或密钥不同
  | "config_mismatch" // 模型 / 工具集 / 系统提示与暂停时不同
  | "log_behind" // 日志比状态还短：连的不是同一份日志
  | "pending_mismatch" // 日志里的 pending 调用与状态不一致：被改过或续跑错了会话
  | "unknown_tool_call" // decisions 指向一个并不 pending 的调用

export class RunStateError extends Error {
  constructor(
    readonly code: RunStateErrorCode,
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${message}`)
    this.name = "RunStateError"
  }
}

export function assertRunStateShape(raw: unknown): asserts raw is SerializedRunState {
  const s = raw as Partial<SerializedRunState> | null
  const ok =
    typeof s === "object" &&
    s !== null &&
    s.v === 1 &&
    typeof s.sessionId === "string" &&
    Number.isInteger(s.lastSeq) &&
    Array.isArray(s.pendingToolCallIds) &&
    s.pendingToolCallIds.every((id) => typeof id === "string") &&
    typeof s.configHash === "string" &&
    typeof s.pendingDigest === "string" &&
    (s.sig === undefined || typeof s.sig === "string")
  if (!ok) throw new RunStateError("malformed", "run 状态不是 v1 的形状")
}

/**
 * 恢复前的全部校验。顺序有讲究：先看形状与会话，再验签名（防伪造），最后与日志对账（防篡改与错连）。
 * 通过后返回日志里的 pending 调用，供循环继续处理。
 */
export async function validateResume(input: {
  state: unknown
  sessionId: string
  timeline: readonly Event[]
  configHash: string
  secret?: string
  allowConfigDrift?: boolean
}): Promise<ToolCallEvent[]> {
  const { state } = input
  assertRunStateShape(state)
  if (state.sessionId !== input.sessionId) {
    throw new RunStateError(
      "session_mismatch",
      `状态属于会话 ${state.sessionId}，当前是 ${input.sessionId}`,
      {
        expected: input.sessionId,
        got: state.sessionId,
      },
    )
  }
  if (input.secret !== undefined) {
    if (state.sig === undefined) throw new RunStateError("missing_signature", "配置了密钥，但状态没有签名")
    if (!(await verifyRunState(state, input.secret))) {
      throw new RunStateError("bad_signature", "状态签名不匹配：内容被改过或密钥不同")
    }
  }
  if (state.configHash !== input.configHash && !input.allowConfigDrift) {
    throw new RunStateError(
      "config_mismatch",
      "模型、工具集或系统提示与暂停时不同；确认无误可传 allowConfigDrift",
      {
        expected: state.configHash,
        got: input.configHash,
      },
    )
  }
  const lastSeq = input.timeline[input.timeline.length - 1]?.seq ?? 0
  if (lastSeq < state.lastSeq) {
    throw new RunStateError("log_behind", `日志只到 seq ${lastSeq}，状态记录的是 ${state.lastSeq}`, {
      logLastSeq: lastSeq,
      stateLastSeq: state.lastSeq,
    })
  }
  const pending = pendingToolCalls(input.timeline)
  const ids = pending.map((c) => c.payload.toolCallId)
  if (
    JSON.stringify(ids) !== JSON.stringify(state.pendingToolCallIds) ||
    (await computePendingDigest(pending)) !== state.pendingDigest
  ) {
    throw new RunStateError("pending_mismatch", "日志里的待处理调用与状态不一致", {
      expected: state.pendingToolCallIds,
      got: ids,
    })
  }
  return pending
}
