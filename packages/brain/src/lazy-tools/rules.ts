/**
 * lazy-tools 模块给模型看的文字（技术方案 §9.10）：工具说明、规则提示、菜单排版、取回结果排版。
 *
 * 渐进式披露的两层（与 skills 同形）：系统提示里只有菜单（每件工具的 name + 一行摘要），完整 schema 要模型自己用
 * `tool_find` 取回——取哪几件、什么时候取是模型的判断（宪法一），规则只给经验：动手前先取、一次取全、只取任务要的。
 * 作为 Socket 的静态 systemPrompt 片段追加在宿主提示之后，整个 run 逐字不变（§9.1 约束 3）。英文：进的是模型上下文。
 */
import { type ContentPart, renderToolReference, type Tool, type ToolReferencePart } from "@reinsjs/core"

export const TOOL_FIND_TOOL_NAME = "tool_find"

export const TOOL_FIND_TOOL_DESCRIPTION = [
  "Load tools from the on-request list so you can call them.",
  '`names` are tool names exactly as listed under "Tools available on request".',
  "The result gives each tool's full description and input schema, and the tools appear in your tool list from your next turn on.",
  "Ask for every listed tool the task will need in one call.",
].join(" ")

/** 规则提示的经验部分；菜单由 renderLazyToolMenu 排在其后 */
export const LAZY_TOOL_RULES = `## Tools available on request
The tools listed below are bound to this session but not loaded yet: only a name and a one-line summary are shown, and they cannot be called until loaded.
- Before starting work that needs one of them, call \`${TOOL_FIND_TOOL_NAME}({ names: [...] })\` with every listed tool the task will need, in one call where possible. Each loaded tool then appears in your tool list from the next turn on, with its full input schema.
- Load only what the task needs. A tool loaded earlier in this conversation stays loaded; do not load it again.
- Do not guess a listed tool's parameters from its summary; load it first.`

export interface LazyToolMenuEntry {
  name: string
  summary: string
}

/** 菜单：每项一行 `- name: summary` */
export function renderLazyToolMenu(entries: readonly LazyToolMenuEntry[]): string {
  const lines = entries.map((e) => `- ${e.name}: ${e.summary}`)
  return `Available on request:\n${lines.join("\n")}`
}

export const TOOL_FIND_INPUT_SCHEMA = {
  type: "object",
  properties: {
    names: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description: 'Tool names to load, exactly as listed under "Tools available on request".',
    },
  },
  required: ["names"],
  additionalProperties: false,
} as const

/** 一件工具的定义引用段（L1）：取回结果里每件工具一段，带完整定义快照（日志自足），降级层按能力位翻成原生块或文本 */
export function toolReferenceOf(tool: Tool): ToolReferencePart {
  return {
    type: "tool_reference",
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }
}

/** 一件工具展开成文本的样子（无原生落点的线上模型看到的、也是估算上界用的）：core `renderToolReference` 的同一份写法 */
export function renderLoadedTool(tool: Tool): string {
  return renderToolReference(toolReferenceOf(tool))
}

/**
 * 取回结果的内容段。`loaded` 是这次取回的菜单工具，每件一个引用段；`notListed` 是模型点了名但不在菜单上的——点名而不是静默忽略，
 * 模型才知道自己记错了名字（或者它本来就在工具表里，直接调即可；本模块看不到别的 Socket 的工具，不替它判断是哪种）。
 * 文本段与引用段分开放：Anthropic 原生路径上引用块进 tool_result、文本段跟在这批结果之后（tool_result 内不能混放）；其余线全展开成文本。
 */
export function renderToolFindResult(input: {
  loaded: readonly Tool[]
  notListed: readonly string[]
}): ContentPart[] {
  const parts: ContentPart[] = []
  if (input.loaded.length > 0) {
    const names = input.loaded.map((t) => t.name).join(", ")
    parts.push({
      type: "text",
      text: `Loaded ${input.loaded.length} tool${input.loaded.length === 1 ? "" : "s"} (${names}); callable from your next turn on.`,
    })
    parts.push(...input.loaded.map(toolReferenceOf))
  } else {
    parts.push({ type: "text", text: "Nothing loaded." })
  }
  if (input.notListed.length > 0) {
    parts.push({
      type: "text",
      text: `Not on the on-request list: ${input.notListed.join(", ")}. Check the spelling against the list; if a name is already in your tool list, call it directly.`,
    })
  }
  return parts
}
