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
  type ToolContext,
  type ToolResult,
} from "@reinsjs/core"
import type { AnyTool, JSONSchema, ToolExecutionContext } from "@tanstack/ai"
import { convertSchemaToJsonSchema, DISCOVERY_TOOL_NAME } from "@tanstack/ai"
import { partAsText, toTanstackContent } from "./content.js"

/** 视图标记：这是 TanStack 宿主工具在 reins 这边的影子，不由 reins 执行 */
export const NATIVE_TOOL: unique symbol = Symbol("reins.tanstack.nativeTool")

export type NativeToolView = ReinsTool & { [NATIVE_TOOL]: true }

export function isNativeToolView(tool: ReinsTool | undefined): tool is NativeToolView {
  return tool !== undefined && (tool as Partial<NativeToolView>)[NATIVE_TOOL] === true
}

/**
 * 宿主在 TanStack 工具上给 reins 看的声明：`toolDefinition({ …, metadata: { reins: { risk: "low" } } })`。
 * 与 reins `Tool` 同名同义——`risk` 给 approval 的缺省 byRisk 与"中断不重放"用（没声明 = 写工具、要问人），
 * `replayable` 覆盖由 risk 推出的可重放性
 */
export interface ReinsToolMetadata {
  risk?: "low" | "medium" | "high"
  replayable?: boolean
}

const RISKS: ReadonlySet<unknown> = new Set(["low", "medium", "high"])

/**
 * TanStack 工具 → reins 只读视图。`metadata.reins` 里的 `risk` / `replayable` 抄进视图（全库审查 2026-11-25 #31：
 * 此前视图带不了 risk，approval 缺省 byRisk 让每个宿主工具都要问人，README 的 `approval({ ask: ["deploy"] })` 名不副实）。
 * 值不合规的字段 fail-closed：当没声明（仍按写工具、要问人），经 `warn` 报出
 */
export interface ViewOfTanstackToolOptions {
  /** `metadata.reins` 的值不合规时的告警出口；不给就不告警 */
  warn?: (message: string) => void
}

/**
 * 第二个参数刻意是选项对象而不是函数（第二波返修 N1）：`tools.map(viewOfTanstackTool)` 会把数组下标当第二个参数传进来，
 * 与 `toolSpecOf` 刻意单参是同一个坑——对象形态下下标只是被忽略（读不到 warn），不会被当函数调用
 */
export function viewOfTanstackTool(tool: AnyTool, options: ViewOfTanstackToolOptions = {}): NativeToolView {
  const warn = typeof options === "object" && options !== null ? options.warn : undefined
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
  // 引擎为 lazy 工具自造的发现工具（`__lazy__tool__discovery__`）宿主声明不了 metadata：它只读、只回工具定义，
  // 与 brain 的 tool_find 同类，缺省按 low（第二波返修 S2）。否则 approval 缺省 byRisk 每次发现都停下来问人
  if (tool.name === DISCOVERY_TOOL_NAME) view.risk = "low"
  // `metadata.reins` 一个键两种含义（第二波返修 N5）：对象 = 宿主在自己的 TanStack 工具上给 reins 的声明（这里读）；
  // `true` = `toTanstackTool` 给包装出来的 reins 工具打的来源标记（不是声明，这里按非对象跳过）。宿主工具不会是后者
  const declared = (tool.metadata as { reins?: unknown } | undefined)?.reins
  if (typeof declared === "object" && declared !== null) {
    const { risk, replayable } = declared as { risk?: unknown; replayable?: unknown }
    if (RISKS.has(risk)) view.risk = risk as NonNullable<ReinsToolMetadata["risk"]>
    else if (risk !== undefined)
      warn?.(
        `tool ${tool.name}: metadata.reins.risk must be "low", "medium" or "high", got ${JSON.stringify(risk)}; treated as undeclared`,
      )
    if (typeof replayable === "boolean") view.replayable = replayable
    else if (replayable !== undefined)
      warn?.(
        `tool ${tool.name}: metadata.reins.replayable must be a boolean, got ${JSON.stringify(replayable)}; treated as undeclared`,
      )
  }
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
 * reins 工具 → TanStack 工具。`needsApproval` 一律**不透传**：布尔与函数两种形态都由适配器在 beforeTools 边界
 * 按 runLoop 的规则判定（先 validate、再问），以 reins 通用中断问人。透传布尔形态会让 TanStack 再开一张原生审批卡：
 * 同一调用两个中断，前端只答 reins 那张时引擎拒绝续跑、run 记 error（全库审查 2026-11-25 #4）
 */
export function toTanstackTool(tool: ReinsTool, bridge: ToolBridge): AnyTool {
  const out: AnyTool = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as JSONSchema,
    // 来源标记：这是 reins 包装出来的工具。与宿主工具上的 `metadata.reins = { risk, … }` 声明同键不同义，见 viewOfTanstackTool
    metadata: { reins: true },
  }
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
  return result.content.map(partAsText).join("\n")
}
