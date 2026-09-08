/**
 * 工具相关的纯函数：给模型看的声明、执行结果归一化。与循环解耦，便于适配器（TanStack / pi）复用。
 */
import type { ContentPart } from "../events/base.js"
import type { ToolSpec } from "../lowering/types.js"
import type { Tool, ToolResult } from "./types.js"

/**
 * 定义一个带入参类型的工具并擦成 Tool：对象字面量里 execute / validate / needsApproval 的 input 都按 TInput 推断，
 * 返回值却能直接放进 Tool[]。不用它也行，只是 needsApproval 写成函数时 TS 会因参数逆变拒绝放进数组。
 */
export function defineTool<TInput>(tool: Tool<TInput>): Tool {
  return tool as Tool
}

/** 工具声明的模型可见部分 */
export function toolSpecOf(tool: Tool): ToolSpec {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
}

function isContentPart(x: unknown): x is ContentPart {
  if (typeof x !== "object" || x === null) return false
  const p = x as { type?: unknown; text?: unknown; mime?: unknown; data?: unknown }
  if (p.type === "text") return typeof p.text === "string"
  if (p.type === "image") return typeof p.mime === "string" && typeof p.data === "string"
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
