/**
 * memory —— 记忆模块（技术方案 §9.6，B6）。
 *
 * 给模型一个 `memory` 工具：形状与 Anthropic `memory_20250818` 对齐（view / create / str_replace / insert / delete / rename，
 * 路径限定在 `/memories`），后端是宿主实现的 MemoryStore（core §5）。库只做三件事（宪法一）：
 * - **给它能力**：六个 command 在 MemoryStore 上执行（commands.ts），文案对齐参考实现，模型已有的习惯直接迁移
 * - **给它边界**：每个路径先规范化再碰存储（paths.ts，拒绝 `..` / 反斜杠 / 百分号编码，只认 `/memories` 之下）；
 *   单文件大小与单次 view 的字符上限；宿主可用 `namespace` 给每个 principal 一块独立的 /memories
 * - **给它记录**：每次成功的读写留一条 `memory_op` 事件（模型不可见，见投影过滤），供配额统计、回放、eval
 * 记什么、什么时候记，判断在模型；规则提示只给经验（rules.ts）。
 *
 * 为什么是自定义工具而不是 Anthropic 的原生 `memory_20250818` 类型：降级层 pi-ai 不支持 provider-defined 工具，
 * 且 reins 要跨模型族；同名同义的 JSON Schema 已足够让模型认出这是它熟悉的工具。
 *
 * 没有 MemoryStore 时按 §5"缺则不注册"：静态贡献是按运行环境算一次的函数（core `StaticContribution`），
 * 工具与规则都不出现，并告警一次 —— 而不是注册一个一用就报错的工具，那会让模型每轮都撞墙。
 */
import type { Socket, SocketSetup, Tool, ToolContext } from "@reins/core"
import {
  bindMemoryFs,
  executeMemoryCommand,
  MEMORY_INPUT_SCHEMA,
  type MemoryCommand,
  type MemoryLimits,
  parseMemoryCommand,
} from "./commands.js"
import { MEMORY_RULES, MEMORY_TOOL_DESCRIPTION, MEMORY_TOOL_NAME } from "./rules.js"

export interface MemoryOptions {
  /**
   * 命名空间：返回加在存储键前面的前缀，模型看到的路径不变。多用户宿主用它隔离：
   * `namespace: (ctx) => \`/users/${ctx.principal?.id ?? "anonymous"}\``。缺省无前缀（全体共享一块 /memories）
   */
  namespace?: (ctx: ToolContext) => string
  /** 单文件上限（UTF-8 字节）。缺省 64 KiB：记忆是给未来的自己看的摘记，不是数据仓库 */
  maxFileBytes?: number
  /** view 单次最多返回的字符数（正文部分），超过按行截断并提示用 view_range 续读。缺省 16000（与 Anthropic 工具说明一致） */
  maxViewChars?: number
  /** 规则提示：缺省内置英文文案；传字符串替换；false 则不碰系统提示 */
  rules?: string | false
  /** 没有 MemoryStore 时的告警出口（每个 memory() 实例只告警一次）。缺省 console.warn */
  warn?: (message: string) => void
}

export const MEMORY_SOCKET_NAME = "memory"
export const DEFAULT_MAX_FILE_BYTES = 64 * 1024
export const DEFAULT_MAX_VIEW_CHARS = 16_000

export function memory(opts: MemoryOptions = {}): Socket {
  const limits: MemoryLimits = {
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxViewChars: opts.maxViewChars ?? DEFAULT_MAX_VIEW_CHARS,
  }
  if (!Number.isInteger(limits.maxFileBytes) || limits.maxFileBytes < 1) {
    throw new RangeError(`memory.maxFileBytes 必须是 ≥1 的整数：${String(limits.maxFileBytes)}`)
  }
  if (!Number.isInteger(limits.maxViewChars) || limits.maxViewChars < 1) {
    throw new RangeError(`memory.maxViewChars 必须是 ≥1 的整数：${String(limits.maxViewChars)}`)
  }
  if (opts.namespace !== undefined && typeof opts.namespace !== "function") {
    throw new RangeError("memory.namespace 必须是函数")
  }
  const namespace = opts.namespace ?? (() => "")
  const warn = opts.warn ?? ((message: string) => console.warn(message))
  let warned = false

  const tool: Tool<MemoryCommand> = {
    name: MEMORY_TOOL_NAME,
    description: MEMORY_TOOL_DESCRIPTION,
    inputSchema: MEMORY_INPUT_SCHEMA as unknown as Record<string, unknown>,
    validate: parseMemoryCommand,
    risk: "low",
    async execute(cmd, ctx) {
      if (!ctx.memory) {
        // 正常装法到不了这里（没有 MemoryStore 时工具不注册）；宿主自己把工具塞进 LoopConfig.tools 才会
        return {
          content: [
            { type: "text", text: "No memory store is configured for this session; memory is unavailable." },
          ],
          isError: true,
        }
      }
      const fs = bindMemoryFs(ctx.memory, namespace(ctx))
      const outcome = await executeMemoryCommand(fs, cmd, limits)
      if (outcome.op) {
        // 留痕排在 tool_result 之前（循环保证）；模型不可见，给配额 / 回放 / eval 看
        ctx.emit({
          type: "core.memory_op",
          actor: "model",
          payload: outcome.op,
          provenance: { source: MEMORY_SOCKET_NAME, ref: ctx.toolCallId },
        })
      }
      return { content: [{ type: "text", text: outcome.text }], isError: outcome.isError }
    },
  }

  const available = (setup: SocketSetup): boolean => {
    if (setup.memory) return true
    if (!warned) {
      warned = true
      warn(
        "[reins/memory] 没有配置 MemoryStore，memory 工具与规则提示未注册。给 runLoop / createAgent 的 store 配上 memory 即可开启。",
      )
    }
    return false
  }

  const socket: Socket = {
    name: MEMORY_SOCKET_NAME,
    tools: (setup) => (available(setup) ? [tool as Tool] : undefined),
  }
  if (opts.rules !== false) {
    const rules = opts.rules ?? MEMORY_RULES
    socket.systemPrompt = (setup) => (setup.memory ? rules : undefined)
  }
  return socket
}
