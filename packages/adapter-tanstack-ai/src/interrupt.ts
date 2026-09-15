/**
 * reins 审批在 TanStack AI 里的落点：通用中断（generic interrupt）。
 *
 * TanStack 自带的审批只认工具上静态的 `needsApproval: true`；reins 的审批是动态的 —— approval 模块按入参判定
 * "这次要问人"（Socket.beforeTool 返回 defer）。动态判定只能在 `onInterruptBoundary(beforeTools)` 边界以
 * 通用中断表达：run 暂停、客户端拿到 `RUN_FINISHED(interrupt)`，答复后带 `resume` 续跑，
 * 我们在 `onInterruptResolution` 里把答复记成 `approval_decision`。
 *
 * 宿主必须把 `reinsApprovalInterrupt` 登记到 `chat({ interrupts: [reinsApprovalInterrupt] })`，否则 TanStack 会在边界抛
 * "not registered on this chat"。两道保护：类型层 `ReinsChatMiddleware` 让漏登记编译不过；运行时 middleware 在 init 读引擎的
 * 中断登记表（`GenericInterruptDefinitionRegistryCapability`），没登记则 `warn` 一次并把 defer 降级为拒绝——留
 * `approval_request` + `approval_decision(false, by: "reins")` 再拦截（fail-closed，R7），工具绝不会在没人批的情况下执行。
 */
import { defineInterrupt } from "@tanstack/ai"
import { isRecord, reinsSchema } from "./schema.js"

export const REINS_APPROVAL_INTERRUPT_ID = "reins.approval"

/** 下发给审批方看的内容：与 `approval_request` 事件同源，多带工具名与入参方便渲染 */
export interface ReinsApprovalPayload {
  toolCallId: string
  name: string
  args: unknown
  policyId: string
  summary: string
}

/** 审批方的答复 */
export interface ReinsApprovalResponse {
  approved: boolean
  /** 谁批的；缺省记为 "tanstack" */
  by?: string
  reason?: string
}

const payloadSchema = reinsSchema<ReinsApprovalPayload>({
  jsonSchema: {
    type: "object",
    properties: {
      toolCallId: { type: "string" },
      name: { type: "string" },
      args: {},
      policyId: { type: "string" },
      summary: { type: "string" },
    },
    required: ["toolCallId", "name", "policyId", "summary"],
  },
  check: (v) => {
    if (!isRecord(v)) return ["payload must be an object"]
    const issues: string[] = []
    for (const k of ["toolCallId", "name", "policyId", "summary"] as const)
      if (typeof v[k] !== "string") issues.push(`${k} must be a string`)
    return issues
  },
})

const responseSchema = reinsSchema<ReinsApprovalResponse>({
  jsonSchema: {
    type: "object",
    properties: {
      approved: { type: "boolean" },
      by: { type: "string" },
      reason: { type: "string" },
    },
    required: ["approved"],
  },
  check: (v) => {
    if (!isRecord(v)) return ["the response must be an object"]
    const issues: string[] = []
    if (typeof v.approved !== "boolean") issues.push("approved must be a boolean")
    if (v.by !== undefined && typeof v.by !== "string") issues.push("by must be a string")
    if (v.reason !== undefined && typeof v.reason !== "string") issues.push("reason must be a string")
    return issues
  },
})

export const reinsApprovalInterrupt = defineInterrupt({
  id: REINS_APPROVAL_INTERRUPT_ID,
  payloadSchema,
  responseSchema,
})

export type ReinsApprovalInterrupt = typeof reinsApprovalInterrupt
