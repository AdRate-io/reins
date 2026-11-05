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

/** 模型引用的摘要（D4）：续跑时模型换了要能察觉 */
export async function computeModelDigest(model: ModelRef): Promise<string> {
  return sha256(JSON.stringify(model))
}

/**
 * pending 调用涉及的工具定义摘要（D4）：按名去重排序，每件取 `[name, description, inputSchema]`，不在表里记 `[name, null]`。
 * 取数口径是**基础工具表**（runLoop 的 baseTools = server 预校验的 `contributions.tools`），不取 beforeModel 补丁改过的本轮工具表。
 * 守的是"被批准的那次调用，执行时还是同一个工具"
 */
export async function computePendingToolsDigest(
  calls: readonly ToolCallEvent[],
  tools: readonly Tool[],
): Promise<string> {
  const names = [...new Set(calls.map((c) => c.payload.name))].sort()
  return sha256(
    JSON.stringify(
      names.map((name) => {
        const t = tools.find((x) => x.name === name)
        return t ? [name, t.description, t.inputSchema] : [name, null]
      }),
    ),
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
  /** 给了 model 与 tools（基础工具表）才写 D4 两个摘要，续跑只比对模型与 pending 工具；缺了退回只比 configHash */
  model?: ModelRef
  tools?: readonly Tool[]
  secret?: string
}): Promise<SerializedRunState> {
  const state: SerializedRunState = {
    v: 1,
    sessionId: input.sessionId,
    lastSeq: input.lastSeq,
    pendingToolCallIds: input.pending.map((c) => c.payload.toolCallId),
    configHash: input.configHash,
    pendingDigest: await computePendingDigest(input.pending),
    ...(input.model !== undefined && input.tools !== undefined
      ? {
          modelDigest: await computeModelDigest(input.model),
          pendingToolsDigest: await computePendingToolsDigest(input.pending, input.tools),
        }
      : {}),
  }
  return input.secret === undefined ? state : signRunState(state, input.secret)
}

// ---- 签名 ----

/**
 * 签名材料：除 sig 外的全部字段，键序固定。D4 两个摘要在场时**追加**在末尾（任一在场即两个都进，缺的记 null），
 * 旧状态的材料保持不变、旧签名照样验得过；给旧状态塞新字段或从新状态删掉它们，材料都变、验签失败——
 * 否则伪造 `pendingToolsDigest` 就能绕开 configHash 校验
 */
function signingMaterial(state: SerializedRunState): string {
  const fields: unknown[] = [
    state.v,
    state.sessionId,
    state.lastSeq,
    state.pendingToolCallIds,
    state.configHash,
    state.pendingDigest,
  ]
  if (state.modelDigest !== undefined || state.pendingToolsDigest !== undefined)
    fields.push(state.modelDigest ?? null, state.pendingToolsDigest ?? null)
  return JSON.stringify(fields)
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
    (s.modelDigest === undefined || typeof s.modelDigest === "string") &&
    (s.pendingToolsDigest === undefined || typeof s.pendingToolsDigest === "string") &&
    (s.sig === undefined || typeof s.sig === "string")
  if (!ok) throw new RunStateError("malformed", "run state is not in the v1 shape")
}

/**
 * 恢复前的全部校验。顺序有讲究：先看形状与会话，再验签名（防伪造），最后与日志对账（防篡改与错连）。
 * 通过后返回日志里的 pending 调用，供循环继续处理。
 *
 * 配置比对两条路（D4）：状态带 `modelDigest` / `pendingToolsDigest` 且调用方给了 `model` 与 `tools`（基础工具表）时，
 * 只比模型与 pending 调用涉及的工具定义——其余变化（加减别的工具、改系统提示）放行，模型会从工具变化说明里得知；
 * 否则（旧状态、调用方没给）仍按 configHash 整体比对。`allowConfigDrift` 两条路都放行。
 */
export async function validateResume(input: {
  state: unknown
  sessionId: string
  timeline: readonly Event[]
  configHash: string
  /** 与 `tools` 一起给才走 D4 收窄的比对 */
  model?: ModelRef
  /** 基础工具表（runLoop 的 baseTools、server 的 `contributions.tools`） */
  tools?: readonly Tool[]
  secret?: string
  allowConfigDrift?: boolean
}): Promise<ToolCallEvent[]> {
  const { state } = input
  assertRunStateShape(state)
  if (state.sessionId !== input.sessionId) {
    throw new RunStateError(
      "session_mismatch",
      `state belongs to session ${state.sessionId}, but the current session is ${input.sessionId}`,
      {
        expected: input.sessionId,
        got: state.sessionId,
      },
    )
  }
  if (input.secret !== undefined) {
    if (state.sig === undefined)
      throw new RunStateError(
        "missing_signature",
        "a secret is configured but the state carries no signature",
      )
    if (!(await verifyRunState(state, input.secret))) {
      throw new RunStateError(
        "bad_signature",
        "state signature mismatch: the contents were altered or the secret differs",
      )
    }
  }
  const narrowed =
    state.modelDigest !== undefined &&
    state.pendingToolsDigest !== undefined &&
    input.model !== undefined &&
    input.tools !== undefined
  if (narrowed && !input.allowConfigDrift) {
    if ((await computeModelDigest(input.model as ModelRef)) !== state.modelDigest) {
      throw new RunStateError("config_mismatch", "the model differs from when the run paused", {
        part: "model",
      })
    }
  } else if (state.configHash !== input.configHash && !input.allowConfigDrift) {
    throw new RunStateError(
      "config_mismatch",
      "model, tool set or system prompt differs from when the run paused; pass allowConfigDrift if this is intended",
      {
        expected: state.configHash,
        got: input.configHash,
      },
    )
  }
  const lastSeq = input.timeline[input.timeline.length - 1]?.seq ?? 0
  if (lastSeq < state.lastSeq) {
    throw new RunStateError(
      "log_behind",
      `the log only reaches seq ${lastSeq}, but the state records ${state.lastSeq}`,
      {
        logLastSeq: lastSeq,
        stateLastSeq: state.lastSeq,
      },
    )
  }
  const pending = pendingToolCalls(input.timeline)
  const ids = pending.map((c) => c.payload.toolCallId)
  if (
    JSON.stringify(ids) !== JSON.stringify(state.pendingToolCallIds) ||
    (await computePendingDigest(pending)) !== state.pendingDigest
  ) {
    throw new RunStateError("pending_mismatch", "pending tool calls in the log do not match the state", {
      expected: state.pendingToolCallIds,
      got: ids,
    })
  }
  // pending 工具定义放在对账之后比：摘要按日志里的 pending 算，日志与状态对得上才有意义
  if (
    narrowed &&
    !input.allowConfigDrift &&
    (await computePendingToolsDigest(pending, input.tools as readonly Tool[])) !== state.pendingToolsDigest
  ) {
    const names = [...new Set(pending.map((c) => c.payload.name))].sort()
    throw new RunStateError(
      "config_mismatch",
      `the definition of pending tool ${names.join(", ")} differs from when the run paused; pass allowConfigDrift if this is intended`,
      { part: "pendingTools", tools: names },
    )
  }
  return pending
}
