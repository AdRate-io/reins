/**
 * 自带工具的模块被同名工具顶掉时的统一处置（真源；全库审查 2026-11-25 #51）。
 *
 * core 合并工具表时同名先到者赢、后到者静默丢掉（`resolveSocketContributions`，登记过的口径，不改）。自带工具的模块——
 * compact（compact / recall）、spill（fetch_blob）、pins（pin）、handoff、memory、skills（skill_read）、lazy-tools（tool_find）——
 * 都在规则提示、说明文字或按工具名认调用的钩子里指向自家工具。宿主或排在前面的 Socket（典型是一台 MCP 服务器）带了同名工具时，
 * 模块的工具被丢掉，模型却会被指向别人的工具（取回外溢、翻技能书都落到别人那里），钩子还会把别人的调用当成自家的
 * （一次 MCP 的 `handoff` 调用就让会话交接）。
 *
 * 统一做法：本次解析的工具表（`SocketSetup.tools`：宿主工具 + 排在前面的 Socket 的贡献）里有同名、却不是自家那个对象的工具，
 * 模块这次就不注册工具与规则，告警一次；按名字认调用的钩子先用 `ownsTool` 确认本 run 绑定的是自家那件，不是就停手。
 * 同一对象不算撞名：宿主把模块的工具对象放进自己的工具表时，绑定的仍是它。
 */
import type { SocketSetup, Tool } from "@reinsjs/core"

/** 自家工具里第一个被同名他人工具顶掉的名字；都没撞返回 undefined。`own` 给名字时，同名的任何工具都算撞 */
export function shadowingToolName(
  bound: readonly Tool[],
  own: readonly (Tool | string)[],
): string | undefined {
  for (const o of own) {
    const name = typeof o === "string" ? o : o.name
    if (bound.some((t) => t.name === name && t !== o)) return name
  }
  return undefined
}

/** 撞名告警（宿主可见，英文）。`factory` 是模块的工厂函数名，如 "skills" */
export function shadowedToolWarning(module: string, factory: string, name: string): string {
  return `[reins/${module}] The tool table already has a tool named ${name} (from the host or a socket registered before ${factory}()), so this module's tools and rules are not registered and its hooks stay idle. Rename that tool (for an MCP server, give mcpTools() a prefix) to enable them.`
}

export interface OwnToolsGuardOptions {
  /** 告警前缀里的模块名，如 "spill" */
  module: string
  /** 工厂函数名，如 "spill" / "lazyTools" */
  factory: string
  /** 模块自带的工具（对象，或建表前只知道的名字） */
  tools: readonly (Tool | string)[]
  warn: (message: string) => void
}

/**
 * 守卫：本次 setup 下模块能不能注册。撞名时按名字告警一次（每个模块实例），之后静默返回 false。
 * 纯函数判定，同一个 setup 的 `tools` 与 `systemPrompt` 两次解析结论必然一致，不必缓存
 */
export function ownToolsGuard(opts: OwnToolsGuardOptions): (setup: Pick<SocketSetup, "tools">) => boolean {
  const warned = new Set<string>()
  return (setup) => {
    const name = shadowingToolName(setup.tools, opts.tools)
    if (name === undefined) return true
    if (!warned.has(name)) {
      warned.add(name)
      opts.warn(shadowedToolWarning(opts.module, opts.factory, name))
    }
    return false
  }
}

/**
 * 本轮绑定的是不是模块自家那件工具：按工具名认调用、或会叫模型调它的钩子先问这一句，不是就停手。
 *
 * 认"同一对象"或"同名且 execute 是同一个函数"：宿主 beforeModel 补丁常把工具表整份浅拷贝（`ctx.tools.map((t) => ({ ...t }))`
 * 改说明），副本不是同一对象，core 却按名字执行、跑的仍是自家闭包——只认对象同一性会让 spill / handoff 等钩子静默停手
 * （发版前终审）。别人的同名工具、或把 execute 包了一层的替身不算自家的；自家工具都有 execute，没有的不认
 */
export function ownsTool(ctx: { tools: readonly Tool[] }, tool: Tool): boolean {
  return ctx.tools.some(
    (t) => t === tool || (t.name === tool.name && tool.execute !== undefined && t.execute === tool.execute),
  )
}
