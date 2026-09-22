/**
 * lazy-tools —— 工具懒发现（技术方案 §9.10，D1）：大工具表的渐进式披露，`Tool.lazy` 的消费者。
 *
 * 库只做两件事（宪法一）：
 * - **让它看见**：系统提示里一份菜单（每件 `lazy: true` 的工具的 name + 一行摘要），run 起步算一次、run 内不变、进 configHash。
 * - **给它能力**：`tool_find({ names })` 取回几件工具的完整 description + inputSchema；从下一轮起那几件出现在请求的工具表里。
 * 取哪几件、什么时候取是模型的判断；规则提示只给经验（rules.ts）。
 *
 * "哪些已取回"**从时间线重建**（宪法二）：本会话所有 `tool_find` 的 tool_call 与其非 isError 的 tool_result 按 toolCallId 配对，
 * 取 `args.names ∩ 当前菜单`。不加新事件类型、不留内存状态——审批暂停后换进程续跑、同一会话下一次 run、compact 折叠掉那段历史，
 * 已取回集合都不变；handoff 到新会话即重置（新时间线，新菜单）。
 *
 * 绑定表不变：`tools_bound` 与 configHash 仍含全部工具、run 内固定（§9.1 约束 3 约束的是绑定表）。每轮请求暴露什么按降级层能力分两路（L1）：
 * - **原生路径**（`ctx.capabilities.deferredTools`，Anthropic 官方 `defer_loading`）：工具表全表下发，菜单工具标 `deferredTools`——
 *   厂商知道它们、模型看不见，`tool_find` 结果里的 `tool_reference` 段由厂商就地展开成定义。工具表整段不变，取回不再打掉缓存前缀
 *   （spikes/l1-deferred-tools：取回后第 2 请求 cacheRead 8488 vs 老路子 0）。已取回、但取回那轮已被 compact 折出本轮视图的工具
 *   例外——历史里没有引用块可展开，就不再延迟、让定义进 tools 块（折叠本就重写了前缀，这一下不多花钱）。
 * - **过滤路径**（其余降级层）：本轮工具表 = 非 lazy + 已取回的 lazy；取回后的第一个请求缓存前缀重算一次（Anthropic 文档：工具表
 *   变动使三段缓存全失效），所以规则文案要求一次把要用的都取回；实测数字见 `spikes/d1-lazy-tools-cache/`。
 *
 * 作用范围是**注册在本模块之前已并入的工具**（`SocketSetup.tools`：宿主工具 + 排在前面的 Socket 贡献，2026-09-22 起）：MCP 经
 * `override` 标了 lazy 的工具也进菜单，前提是 `lazyTools()` 注册在 `mcpTools()` 之后——静态贡献按注册顺序依次解析，后面的看得见前面的，
 * 反过来不行。注册在本模块之后的 Socket 贡献的 lazy 工具不进菜单也不藏（菜单上没有的工具若被藏起来就等于消失），`beforeModel`
 * 见到这样的工具告警一次指出顺序。模块用对象同一性（WeakSet）记住"哪些工具是菜单工具"，同一个 Socket 实例给多个 agent 定义共用也不会串。
 *
 * 模型没取回就直接调菜单里的工具：`beforeTool` 回 `block` 并指向 `tool_find`——不拦的话循环回"未知工具"，模型会以为工具不存在；
 * 也不放行，因为请求里没给 schema 的调用入参多半不对（原生路径同样拦：厂商知道这件工具、模型只凭菜单摘要就能报出名字）。
 * 续跑补齐 pending 时没有 beforeModel、表是全表，隐藏工具照常执行。
 *
 * trust：工具说明与 schema 是宿主配置，视同系统提示可信，`tool_find` 声明 `resultTrust: "system"`（与 `skill_read` 同一条理由）。
 * MCP 工具的说明来自服务器，但它本就直接进请求的 tools 块、与系统提示同一信任层级，经 `tool_find` 取回不另降级。
 * `resultPolicy.maxTokens` 按"最大的 maxPerCall 件条目估算之和 + 256"在 setup 时算出：spill 永不把 schema 换成 untrusted 预览。
 *
 * 缺则不注册：此前并入的工具里没有一件 `lazy: true`、或已有同名 `tool_find` → 工具与菜单都不出现，告警一次（同 skills）。
 * 不做：关键词搜索（菜单就是搜索空间，200 行约 4k token 且逐轮不变）、按 provider 原生 deferred-tools 下发（降级层的优化，另立任务）。
 */
import {
  type Event,
  estimateTextTokens,
  type Socket,
  type SocketSetup,
  type Tool,
  type ToolCallEvent,
  type TurnContext,
} from "@reinsjs/core"
import {
  LAZY_TOOL_RULES,
  type LazyToolMenuEntry,
  renderLazyToolMenu,
  renderLoadedTool,
  renderToolFindResult,
  TOOL_FIND_INPUT_SCHEMA,
  TOOL_FIND_TOOL_DESCRIPTION,
  TOOL_FIND_TOOL_NAME,
} from "./rules.js"

export interface LazyToolsOptions {
  /**
   * 菜单每项的一行摘要，缺省取 description 的首个非空行、空白折成一个空格、超 `summaryChars` 截断加 "…"。
   * 宿主的 description 首行不适合当摘要时（如以参数表开头）用它换
   */
  summarize?: (tool: Tool) => string
  /** 缺省摘要的字符上限，缺省 160；只对缺省 summarize 生效 */
  summaryChars?: number
  /** 一次 `tool_find` 最多取回几件，缺省 20；同时决定 resultPolicy.maxTokens 的上界 */
  maxPerCall?: number
  /**
   * 规则提示的经验部分：缺省内置英文 `LAZY_TOOL_RULES`；传字符串替换（菜单仍自动排在其后）；
   * false 则完全不碰系统提示——工具与过滤仍生效，菜单由宿主自己排（`lazyMenuOf` / `renderLazyToolMenu` 可用）。
   * 代价：菜单不在本模块的贡献里就不进 configHash，暂停期间工具摘要变化续跑察觉不到（工具名本就在 configHash 里）
   */
  rules?: string | false
  /** 告警出口（没有 lazy 工具、宿主同名工具），每个 lazyTools() 实例对每个原因只告警一次。缺省 console.warn */
  warn?: (message: string) => void
}

export const LAZY_TOOLS_SOCKET_NAME = "lazy-tools"
export const DEFAULT_LAZY_SUMMARY_CHARS = 160
export const DEFAULT_TOOL_FIND_MAX = 20

/** 缺省摘要：description 首个非空行，空白折叠，超长截断；没有正文就用工具名 */
export function summarizeTool(tool: Tool, maxChars = DEFAULT_LAZY_SUMMARY_CHARS): string {
  const line =
    tool.description
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? tool.name
  const flat = line.replace(/\s+/g, " ")
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

export interface LazyToolMenu {
  /** 菜单工具，按 name 排序 */
  tools: Tool[]
  entries: LazyToolMenuEntry[]
  byName: Map<string, Tool>
}

/**
 * 从一张工具表挑出 `lazy: true` 的做菜单。纯函数，菜单与测试共用；模块传的是 `SocketSetup.tools`（到本模块为止已并入的表）。
 * 按 name 排序，与给的顺序无关——菜单进 configHash，顺序抖动会误判配置漂移。
 */
export function lazyMenuOf(
  tools: readonly Tool[],
  summarize: (tool: Tool) => string = (t) => summarizeTool(t),
): LazyToolMenu {
  const picked = tools
    .filter((t) => t.lazy === true)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const entries = picked.map((t) => ({ name: t.name, summary: summarize(t).replace(/\s*\n\s*/g, " ") }))
  return { tools: picked, entries, byName: new Map(picked.map((t) => [t.name, t])) }
}

export interface ToolFindInput {
  /** 去重后的名字，保持模型给的顺序 */
  names: string[]
}

/** 解析并校验模型给的入参：非空字符串数组、去重、不超过 maxPerCall。是否在菜单上不在这里判——不在的名字由结果点名 */
export function parseToolFindInput(raw: unknown, maxPerCall = DEFAULT_TOOL_FIND_MAX): ToolFindInput {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { names?: unknown }).names)) {
    throw new RangeError(`${TOOL_FIND_TOOL_NAME} expects { names: string[] }`)
  }
  const list = (raw as { names: unknown[] }).names
  if (list.length === 0) throw new RangeError("`names` must list at least one tool")
  const names: string[] = []
  for (const n of list) {
    if (typeof n !== "string" || n.trim().length === 0)
      throw new RangeError("`names` must be non-empty strings")
    const name = n.trim()
    if (!names.includes(name)) names.push(name)
  }
  if (names.length > maxPerCall) {
    throw new RangeError(`\`names\` lists ${names.length} tools; load at most ${maxPerCall} per call`)
  }
  return { names }
}

/**
 * 从时间线重建"已取回"的菜单工具名：`tool_find` 的 tool_call 与其**非 isError** 的 tool_result 按 toolCallId 配对，
 * 取 `args.names ∩ menuNames`。入参按事件里的原样解析（去重前的原文），坏形状的条目跳过。
 * 只认非 isError 的结果：被审批策略拦下（"工具调用被拦截"）或入参不合法的调用没有取回任何东西。
 */
export function revealedLazyTools(timeline: readonly Event[], menuNames: ReadonlySet<string>): Set<string> {
  const succeeded = new Set<string>()
  for (const e of timeline) {
    if (e.type !== "core.tool_result") continue
    const p = e.payload as { toolCallId?: unknown; name?: unknown; isError?: unknown }
    if (p.name === TOOL_FIND_TOOL_NAME && p.isError === false && typeof p.toolCallId === "string")
      succeeded.add(p.toolCallId)
  }
  const revealed = new Set<string>()
  if (succeeded.size === 0) return revealed
  for (const e of timeline) {
    if (e.type !== "core.tool_call") continue
    const { toolCallId, name, args } = (e as ToolCallEvent).payload
    if (name !== TOOL_FIND_TOOL_NAME || !succeeded.has(toolCallId)) continue
    const list = (args as { names?: unknown } | null)?.names
    if (!Array.isArray(list)) continue
    for (const n of list) {
      if (typeof n !== "string") continue
      const trimmed = n.trim()
      if (menuNames.has(trimmed)) revealed.add(trimmed)
    }
  }
  return revealed
}

/**
 * 一次取回最多返回多大：菜单里条目估算最大的 maxPerCall 件之和，加表头与分隔余量。
 * 用它做 `resultPolicy.maxTokens`，spill 的按工具限额永远放行——schema 换成预览 + fetch_blob 取回来是 untrusted，等于白取
 */
export function toolFindResultBound(menu: LazyToolMenu, maxPerCall: number): number {
  const sizes = menu.tools.map((t) => estimateTextTokens(renderLoadedTool(t))).sort((a, b) => b - a)
  return sizes.slice(0, maxPerCall).reduce((sum, n) => sum + n, 0) + 256
}

interface Resolved {
  menu: LazyToolMenu
  tool: Tool
}

export function lazyTools(opts: LazyToolsOptions = {}): Socket {
  const summaryChars = opts.summaryChars ?? DEFAULT_LAZY_SUMMARY_CHARS
  if (!Number.isInteger(summaryChars) || summaryChars < 1) {
    throw new RangeError(`lazyTools.summaryChars must be an integer >= 1, got ${String(summaryChars)}`)
  }
  const maxPerCall = opts.maxPerCall ?? DEFAULT_TOOL_FIND_MAX
  if (!Number.isInteger(maxPerCall) || maxPerCall < 1) {
    throw new RangeError(`lazyTools.maxPerCall must be an integer >= 1, got ${String(maxPerCall)}`)
  }
  const summarize = opts.summarize ?? ((t: Tool) => summarizeTool(t, summaryChars))
  const warn = opts.warn ?? ((message: string) => console.warn(message))
  const warned = new Set<string>()
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return
    warned.add(key)
    warn(message)
  }

  /** 哪些 Tool 对象是（某次 setup 的）菜单工具：对象同一性，注册在本模块之后的 Socket 贡献的同名 / 标 lazy 的工具不在其中 */
  const menuTools = new WeakSet<Tool>()
  /** 每次 run 起步 tools 与 systemPrompt 各被解析一次，菜单只算一遍：按 setup 对象缓存 */
  const resolved = new WeakMap<SocketSetup, Resolved | undefined>()
  const resolveFor = (setup: SocketSetup): Resolved | undefined => {
    if (resolved.has(setup)) return resolved.get(setup)
    let out: Resolved | undefined
    if (setup.tools.some((t) => t.name === TOOL_FIND_TOOL_NAME)) {
      // 同名以先到者为准（resolveSocketContributions 去重规则）：本模块的工具会被丢掉，菜单却仍会指向 "tool_find"——
      // 那是宿主或前面某个 Socket 的另一个工具。宁可整个不注册
      warnOnce(
        "host-tool",
        `[reins/lazy-tools] The tool table already has a tool named ${TOOL_FIND_TOOL_NAME} (from the host or a socket registered before lazyTools()), so this module's tool and menu are not registered. Rename that tool to enable them.`,
      )
    } else {
      const menu = lazyMenuOf(setup.tools, summarize)
      if (menu.tools.length === 0) {
        warnOnce(
          "no-lazy",
          "[reins/lazy-tools] No tool bound before lazyTools() is marked lazy: true, so tool_find and the menu are not registered. Mark the tools you want disclosed on demand with lazy: true, and register lazyTools() after the sockets (such as mcpTools()) that contribute them.",
        )
      } else {
        for (const t of menu.tools) menuTools.add(t)
        out = { menu, tool: makeToolFind(menu, maxPerCall) }
      }
    }
    resolved.set(setup, out)
    return out
  }

  /** 本轮被藏起来的菜单工具（beforeModel 记、beforeTool 查）；ctx 对象一轮一个 */
  const hiddenByTurn = new WeakMap<TurnContext, Map<string, Tool>>()

  const socket: Socket = {
    name: LAZY_TOOLS_SOCKET_NAME,
    tools: (setup) => {
      const r = resolveFor(setup)
      return r ? [r.tool] : undefined
    },
    beforeModel(ctx) {
      const menuNames = new Set<string>()
      const late: string[] = []
      for (const t of ctx.tools) {
        if (t.lazy !== true) continue
        if (menuTools.has(t)) menuNames.add(t.name)
        else late.push(t.name)
      }
      if (late.length > 0) {
        // 标了 lazy 却不在菜单：贡献它的 Socket 注册在本模块之后。不藏（菜单上没有等于消失），只指出顺序
        warnOnce(
          "late",
          `[reins/lazy-tools] ${late.length} tool(s) marked lazy: true are not on the menu because their socket is registered after lazyTools(): ${late.sort().join(", ")}. They are sent in full every turn. Register lazyTools() after the sockets that contribute them.`,
        )
      }
      if (menuNames.size === 0) return undefined
      const revealed = revealedLazyTools(ctx.timeline, menuNames)
      const hidden = new Map<string, Tool>()
      for (const t of ctx.tools) if (menuNames.has(t.name) && !revealed.has(t.name)) hidden.set(t.name, t)
      hiddenByTurn.set(ctx, hidden)
      if (ctx.capabilities.deferredTools) {
        // 原生路径：全表下发。没取回的延迟（模型看不见）；取回了且取回那轮还在本轮视图里的也延迟（厂商从历史里的引用块展开）；
        // 取回了但那轮已被折出视图的不延迟——历史里没有引用块，定义只能进 tools 块
        const inView = revealedLazyTools(ctx.events, menuNames)
        const deferred = [...menuNames].filter((n) => !revealed.has(n) || inView.has(n))
        return deferred.length > 0 ? { deferredTools: deferred } : undefined
      }
      const visible = ctx.tools.filter((t) => !hidden.has(t.name))
      return hidden.size > 0 ? { tools: visible } : undefined
    },
    beforeTool(ctx, call) {
      // 只看本轮记下的"被藏的菜单工具"：过滤路径下它不在表里（循环给的 tool 是 undefined），原生路径下它在全表里但模型不该看见
      const name = call.payload.name
      if (!hiddenByTurn.get(ctx)?.has(name)) return undefined
      return {
        block: `Tool "${name}" is on the on-request list but not loaded yet. Call ${TOOL_FIND_TOOL_NAME}({ names: [${JSON.stringify(name)}] }) first; it becomes callable from your next turn.`,
      }
    },
  }
  if (opts.rules !== false) {
    const rules = opts.rules ?? LAZY_TOOL_RULES
    socket.systemPrompt = (setup) => {
      const r = resolveFor(setup)
      return r ? `${rules}\n\n${renderLazyToolMenu(r.menu.entries)}` : undefined
    }
  }
  return socket
}

/** 按这次 setup 的菜单造 tool_find：名字 / 说明 / schema 逐字固定（configHash 稳定），只有闭包里的菜单不同 */
function makeToolFind(menu: LazyToolMenu, maxPerCall: number): Tool {
  const tool: Tool<ToolFindInput> = {
    name: TOOL_FIND_TOOL_NAME,
    description: TOOL_FIND_TOOL_DESCRIPTION,
    inputSchema: TOOL_FIND_INPUT_SCHEMA as unknown as Record<string, unknown>,
    validate: (raw) => parseToolFindInput(raw, maxPerCall),
    risk: "low",
    // 工具说明与 schema 是宿主配置，视同系统提示可信（与 skill_read 同理）
    resultTrust: "system",
    resultPolicy: { maxTokens: toolFindResultBound(menu, maxPerCall), overflow: "spill" },
    execute(input) {
      const loaded: Tool[] = []
      const notListed: string[] = []
      for (const name of input.names) {
        const t = menu.byName.get(name)
        if (t) loaded.push(t)
        else notListed.push(name)
      }
      return { content: renderToolFindResult({ loaded, notListed }), isError: loaded.length === 0 }
    },
  }
  return tool as Tool
}
