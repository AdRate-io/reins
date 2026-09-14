/**
 * 工具相关的纯函数：给模型看的声明、执行结果归一化。与循环解耦，便于适配器（TanStack / pi）复用。
 */
import type { ContentPart, Trust } from "../events/base.js"
import type { ToolSpec } from "../lowering/types.js"
import type { Tool, ToolResult } from "./types.js"

/**
 * 工具结果事件该带的 trust（§14）：工具声明了 `resultTrust` 且结果不是错误 → 按声明；否则 undefined（事件工厂按 actor 缺省，即 untrusted）。
 * 这是唯一的判定点——循环的两条路（execute 结果、宿主回填的客户端工具结果）与 TanStack 适配器的两条路都调它，
 * "同一个判定写两处必须同一个纯函数"（踩坑记录 configHash / pendingDigest / decisions 三次教训）。
 */
export function toolResultTrust(tool: Tool | undefined, isError: boolean): Trust | undefined {
  if (!tool || tool.resultTrust === undefined || isError) return undefined
  return tool.resultTrust
}

/**
 * 定义一个带入参类型的工具并擦成 Tool：对象字面量里 execute / validate / needsApproval 的 input 都按 TInput 推断，
 * 返回值却能直接放进 Tool[]。不用它也行，只是 needsApproval 写成函数时 TS 会因参数逆变拒绝放进数组。
 */
export function defineTool<TInput>(tool: Tool<TInput>): Tool {
  return tool as Tool
}

/** 工具声明的模型可见部分（刻意单参：常被 `tools.map(toolSpecOf)` 调用，多一个参数就会吃进下标） */
export function toolSpecOf(tool: Tool): ToolSpec {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
}

/** 带"声明但不载入"标记的规格（L1）：runLoop 按 BeforeModelPatch.deferredTools 对本轮工具表逐件调 */
export function deferredToolSpecOf(tool: Tool, deferred: boolean): ToolSpec {
  return deferred ? { ...toolSpecOf(tool), deferLoading: true } : toolSpecOf(tool)
}

/** 工具返回值里能认出的内容段：文本、图片、工具定义引用（L1）。宿主经 HTTP 送来的用户消息另有白名单（server），不含引用段 */
export function isContentPart(x: unknown): x is ContentPart {
  if (typeof x !== "object" || x === null) return false
  const p = x as {
    type?: unknown
    text?: unknown
    mime?: unknown
    data?: unknown
    name?: unknown
    description?: unknown
    inputSchema?: unknown
  }
  if (p.type === "text") return typeof p.text === "string"
  if (p.type === "image") return typeof p.mime === "string" && typeof p.data === "string"
  if (p.type === "tool_reference") {
    return (
      typeof p.name === "string" &&
      typeof p.description === "string" &&
      typeof p.inputSchema === "object" &&
      p.inputSchema !== null &&
      !Array.isArray(p.inputSchema)
    )
  }
  return false
}

function isToolResult(x: unknown): x is ToolResult {
  if (typeof x !== "object" || x === null) return false
  const r = x as { content?: unknown; isError?: unknown }
  return (
    Array.isArray(r.content) &&
    r.content.every(isContentPart) &&
    (r.isError === undefined || typeof r.isError === "boolean")
  )
}

/**
 * execute 的返回值 → 模型看到的内容。规则按直觉：
 * - string → 一段文本
 * - ContentPart[] → 原样
 * - { content, isError? } → 原样（唯一能表达"这是错误"的形态）
 * - undefined / null → 空文本（工具没话说也得给模型一个结果块）
 * - 其余 → JSON 文本
 */
export function normalizeToolOutput(output: unknown): ToolResult {
  if (typeof output === "string") return { content: [{ type: "text", text: output }] }
  if (output === undefined || output === null) return { content: [{ type: "text", text: "" }] }
  if (Array.isArray(output) && output.every(isContentPart)) return { content: output }
  if (isToolResult(output)) return output
  const json = JSON.stringify(output)
  return { content: [{ type: "text", text: typeof json === "string" ? json : String(output) }] }
}

export function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === "string" ? err : (JSON.stringify(err) ?? String(err))
}
