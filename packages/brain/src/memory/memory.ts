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
import type { Socket, SocketSetup, Tool, ToolContext } from "@reinsjs/core"
import { ownToolsGuard } from "../shared/own-tools.js"
import { isCanonicalKeyPrefix } from "../shared/paths.js"
import {
  bindMemoryFs,
  executeMemoryCommand,
  expandMemoryDirectories,
  MEMORY_INPUT_SCHEMA,
  type MemoryCommand,
  type MemoryLimits,
  parseMemoryCommand,
} from "./commands.js"
import { hasMemorySegment, MEMORY_ROOT, resolveMemoryPath } from "./paths.js"
import { MEMORY_RULES, MEMORY_TOOL_DESCRIPTION, MEMORY_TOOL_NAME } from "./rules.js"

export interface MemoryOptions {
  /**
   * 命名空间：返回加在存储键前面的前缀，模型看到的路径不变，存储键是 `<namespace>/memories/…`。多用户宿主用它隔离：
   * `namespace: (ctx) => \`/users/${ctx.principal?.id ?? "anonymous"}\``。缺省无前缀（全体共享一块 /memories）。
   * 返回值每次调用前校验（fail-closed）：须是空串，或 `/` 起、不以 `/` 收、无空段与 `.` / `..` 段、不含 `memories` 段的路径——
   * 否则两个前缀可能互相嵌套（`/a` 的 `/memories/x/memories/f` 就是 `/a/memories/x` 的 `/memories/f`）。
   * 不合规时本次调用 isError、不碰存储，经 `warn` 告警（每个 memory() 实例只告一次，报第一个坏值）。principal id 里可能带 `/` 时宿主自己先编码
   */
  namespace?: (ctx: ToolContext) => string
  /** 单文件上限（UTF-8 字节）。缺省 64 KiB：记忆是给未来的自己看的摘记，不是数据仓库 */
  maxFileBytes?: number
  /** view 单次最多返回的字符数（正文部分），超过按行截断并提示用 view_range 续读。缺省 16000（与 Anthropic 工具说明一致） */
  maxViewChars?: number
  /**
   * 常设目录（模型可见路径，如 `["/memories/personal", "/memories/project"]`）：宿主把记忆分层挂载时，
   * 某层还没有文件也让模型看得见——`view` 它返回空列表而不是"不存在"，`view /memories` 也列出它；
   * 祖先目录自动算进来。只改"存不存在"的判定，不放宽任何写操作：常设目录不能被当文件写，模型也删不掉它。
   * 缺省没有（与参考实现一致：没有文件的目录不存在）
   */
  directories?: readonly string[]
  /** 规则提示：缺省内置英文文案；传字符串替换；false 则不碰系统提示 */
  rules?: string | false
  /**
   * 告警出口（各自每个 memory() 实例只告警一次）：没有 MemoryStore；namespace 返回值不合规；工具表里已有别家的 memory 工具
   * （宿主或排在前面的 Socket，如 MCP，此时本模块整个不注册）。缺省 console.warn
   */
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
    throw new RangeError(`memory.maxFileBytes must be an integer >= 1, got ${String(limits.maxFileBytes)}`)
  }
  if (!Number.isInteger(limits.maxViewChars) || limits.maxViewChars < 1) {
    throw new RangeError(`memory.maxViewChars must be an integer >= 1, got ${String(limits.maxViewChars)}`)
  }
  if (opts.namespace !== undefined && typeof opts.namespace !== "function") {
    throw new RangeError("memory.namespace must be a function")
  }
  const directories = expandMemoryDirectories(resolveDirectories(opts.directories))
  const namespace = opts.namespace ?? (() => "")
  const warn = opts.warn ?? ((message: string) => console.warn(message))
  let warned = false
  /**
   * 不合规的 namespace 只告警一次（每个实例）：namespace 多由 principal id 拼成，按值去重的集合会随租户增多在长驻进程里一直涨；
   * 返回坏值是宿主代码的 bug，报出第一个就够定位
   */
  let warnedNamespace = false

  const tool: Tool<MemoryCommand> = {
    name: MEMORY_TOOL_NAME,
    description: MEMORY_TOOL_DESCRIPTION,
    inputSchema: MEMORY_INPUT_SCHEMA as unknown as Record<string, unknown>,
    validate: parseMemoryCommand,
    risk: "low",
    // low 只表示不用问人；insert / str_replace / delete / rename 不幂等（再跑一遍会插重复行、把成功的删除报成不存在），
    // 开始动手后被中断的调用续跑时不能重放，落"结果未知"由模型 view 后自己判断
    replayable: false,
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
      const prefix = namespace(ctx)
      if (!isValidNamespace(prefix)) {
        // fail-closed：不合规的前缀可能与别的 principal 的记忆互相嵌套，一个键都不碰。细节只给宿主（可能含 principal id）
        if (!warnedNamespace) {
          warnedNamespace = true
          warn(
            `[reins/memory] memory.namespace must return "" or a path starting with "/", not ending with "/", with no empty, . or .. segments and no "${MEMORY_ROOT.slice(1)}" segment, got ${JSON.stringify(prefix) ?? String(prefix)}. The memory tool refuses every call in sessions that get an invalid namespace; further invalid values are not reported.`,
          )
        }
        return {
          content: [
            {
              type: "text",
              text: "Memory is unavailable in this session: the host's memory namespace is invalid.",
            },
          ],
          isError: true,
        }
      }
      const fs = bindMemoryFs(ctx.memory, prefix, directories)
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

  // memory 被别家同名工具顶掉时整个不注册（shared/own-tools.ts）：规则会让模型把要记的东西交给别人的工具
  const registers = ownToolsGuard({
    module: MEMORY_SOCKET_NAME,
    factory: "memory",
    tools: [tool as Tool],
    warn,
  })

  /** 本次 setup 下工具与规则是否注册：有 MemoryStore 且没被顶掉。tools 与 systemPrompt 共用，告警各只一次 */
  const available = (setup: SocketSetup): boolean => {
    if (setup.memory) return registers(setup)
    if (!warned) {
      warned = true
      warn(
        "[reins/memory] No MemoryStore configured, so the memory tool and its rules are not registered. Pass a memory store to runLoop / createAgent to enable them.",
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
    socket.systemPrompt = (setup) => (available(setup) ? rules : undefined)
  }
  return socket
}

/**
 * namespace 返回值是否可用：空串（全体共享）或规范绝对路径，且不含 memories 段。
 * 规范 + 无 memories 段保证不同前缀的记忆键空间互不嵌套：键的 memories 段恰好落在前缀之后那一段
 */
function isValidNamespace(ns: unknown): ns is string {
  if (typeof ns !== "string") return false
  return ns === "" || (isCanonicalKeyPrefix(ns) && !hasMemorySegment(ns))
}

/** 构造期校验常设目录：与模型给的路径走同一个规范化函数（同一个值两处比对调同一个纯函数），根本身不算 */
function resolveDirectories(dirs: unknown): string[] {
  if (dirs === undefined) return []
  if (!Array.isArray(dirs))
    throw new RangeError(`memory.directories must be an array of paths, got ${typeof dirs}`)
  return dirs.map((d, i) => {
    let p: string
    try {
      p = resolveMemoryPath(d)
    } catch {
      throw new RangeError(
        `memory.directories[${i}] must be a path under ${MEMORY_ROOT}, got ${JSON.stringify(d)}`,
      )
    }
    if (p === MEMORY_ROOT) {
      throw new RangeError(
        `memory.directories[${i}] must be a path under ${MEMORY_ROOT}, not the root itself`,
      )
    }
    return p
  })
}
