/**
 * 工具在两边的桥接。
 *
 * - TanStack 宿主工具 → reins **只读视图**：Socket（审批策略、外溢等）要看工具的名字、schema、风险、是否要审批；
 *   视图不带 execute，执行仍由 TanStack 做。视图打上 NATIVE_TOOL 标记，适配器据此不重复做 TanStack 已经做的事
 *   （静态 needsApproval 由 TanStack 自己的审批中断处理）。
 * - reins 工具（脑子模块的 compact / pin / fetch_blob / memory / handoff …）→ TanStack 工具：把 execute 包一层，
 *   造出 reins 的 ToolContext（toolCallId、存储、emit 留痕），结果按 reins 规则归一后存进 bridge.outputs，
 *   afterTool 钩子从那里拿到精确的 content / isError，而不是 TanStack JSON 化之后的形态。
 */
import {
  errorMessageOf,
  isSubagentPause,
  normalizeToolOutput,
  type Tool as ReinsTool,
  renderToolReference,
  type ToolContext,
  type ToolResult,
} from "@reinsjs/core"
import type { AnyTool, JSONSchema, ToolExecutionContext } from "@tanstack/ai"
import { convertSchemaToJsonSchema } from "@tanstack/ai"
import { toTanstackContent } from "./content.js"

/** 视图标记：这是 TanStack 宿主工具在 reins 这边的影子，不由 reins 执行 */
export const NATIVE_TOOL: unique symbol = Symbol("reins.tanstack.nativeTool")

export type NativeToolView = ReinsTool & { [NATIVE_TOOL]: true }

export function isNativeToolView(tool: ReinsTool | undefined): tool is NativeToolView {
  return tool !== undefined && (tool as Partial<NativeToolView>)[NATIVE_TOOL] === true
}

/** TanStack 工具 → reins 只读视图 */
export function viewOfTanstackTool(tool: AnyTool): NativeToolView {
  const view: NativeToolView = {
    [NATIVE_TOOL]: true,
    name: tool.name,
    description: tool.description,
    inputSchema: (convertSchemaToJsonSchema(tool.inputSchema) as Record<string, unknown> | undefined) ?? {
      type: "object",
    },
    side: tool.execute ? "server" : "client",
  }
  if (tool.needsApproval === true) view.needsApproval = true
  return view
}

/** 包装 reins 工具时需要的运行环境 */
export interface ToolBridge {
  sessionId: string
  toolContextBase: Omit<ToolContext, "toolCallId" | "signal" | "emit">
  emit(draft: Parameters<ToolContext["emit"]>[0]): void
  /** 按 toolCallId 存归一后的结果，供 afterTool 精确取用 */
  outputs: Map<string, ToolResult>
}

/**
 * reins 工具 → TanStack 工具。`needsApproval` 只透传布尔形态（TanStack 只认布尔）；函数形态由适配器在
 * beforeTools 边界按 runLoop 的规则判定（circular：见 middleware 的 beforeTools）。
 */
export function toTanstackTool(tool: ReinsTool, bridge: ToolBridge): AnyTool {
  const out: AnyTool = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as JSONSchema,
    metadata: { reins: true },
  }
  if (tool.needsApproval === true) out.needsApproval = true
  const execute = tool.execute?.bind(tool)
  if (execute) {
    out.execute = async (args: unknown, tctx?: ToolExecutionContext<unknown>) => {
      const toolCallId = tctx?.toolCallId ?? ""
      const ctx: ToolContext = {
        ...bridge.toolContextBase,
        toolCallId,
        ...(tctx?.abortSignal ? { signal: tctx.abortSignal } : {}),
        emit: bridge.emit,
      }
      let input: unknown = args
      // 入参校验按 reins 规则（TanStack 只对 Standard Schema 校验，reins 工具的 inputSchema 是裸 JSON Schema）
      try {
        if (tool.validate) input = tool.validate(input)
      } catch (err) {
        const result: ToolResult = {
          content: [{ type: "text", text: `Invalid arguments: ${errorMessageOf(err)}` }],
          isError: true,
        }
        bridge.outputs.set(toolCallId, result)
        throw new Error(result.content[0]?.type === "text" ? result.content[0].text : "Invalid arguments")
      }
      const raw = await execute(input, ctx)
      // 子代理暂停冒泡（§10.1）在 TanStack 路径做不到：TanStack 在边界只能整轮暂停，且中断由它自己的 interrupts 表达，
      // 没法把"子会话等审批"翻成一个可续跑的中断。fail-closed：按失败交给模型，子会话保留（末条 run_paused），宿主可另行续跑
      const result: ToolResult = isSubagentPause(raw)
        ? {
            content: [
              {
                type: "text",
                text: `subagent session ${raw.detail.childSessionId} is paused (${raw.detail.reason}) and waiting on the host; this path cannot bubble the pause up to the parent run, so the call is treated as unfinished`,
              },
            ],
            isError: true,
          }
        : tool.toModelOutput
          ? { content: tool.toModelOutput(raw) }
          : normalizeToolOutput(raw)
      bridge.outputs.set(toolCallId, result)
      // isError 在 TanStack 里只能以"执行抛错"表达；正文已存在 outputs，抛出去的文本只给 TanStack 的客户端看
      if (result.isError) throw new Error(textOf(result))
      return toTanstackContent(result.content)
    }
  }
  return out
}

function textOf(result: ToolResult): string {
  return result.content
    .map((p) =>
      p.type === "text" ? p.text : p.type === "tool_reference" ? renderToolReference(p) : `[image ${p.mime}]`,
    )
    .join("\n")
}
