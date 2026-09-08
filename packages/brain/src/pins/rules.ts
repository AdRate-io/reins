/**
 * pins 模块给模型看的文字（技术方案 §9.3）：工具说明与规则提示。
 *
 * 与 compact 的规则一样，这是"经验"不是"指令"：什么值得钉、什么不值得，判断在模型。
 * 作为 Socket 的静态 systemPrompt 片段追加在宿主提示之后，整个 run 逐字不变（prompt cache 约束 3）。
 * 用英文写：进的是模型上下文。宿主要换措辞，传 pins({ rules }) 或 rules: false 自己放。
 */

export const PIN_TOOL_NAME = "pin"

export const PIN_TOOL_DESCRIPTION = [
  "Pin a short note so it survives compaction verbatim and is shown again right after every summary.",
  "Use it for the user's explicit constraints, the goal as stated, and identifiers or numbers you will need after folding.",
  "Pins are permanent until replaced: to update one, pass the exact text of the old note in `replaces`.",
  "Notes pinned by the host cannot be replaced.",
].join(" ")

export const PIN_RULES = `## Pinned notes
Notes marked kind="pin" survive compaction verbatim and reappear right after each summary, so the pins are what you can rely on after folding. You have a \`${PIN_TOOL_NAME}\` tool to add one.
- Pin what must not drift: the user's explicit constraints, the goal in the user's words, identifiers and numbers you will need later. One or two sentences each.
- Do not pin what you can re-derive, large content, or the current step. Every pin costs context on every turn until it is replaced.
- When a pinned fact changes, pin the new version with \`replaces\` set to the old note's exact text instead of adding a second note. Notes pinned by the host are the host's constraints and cannot be replaced.
- Before compacting, check the pins still say what you need; whatever is not pinned or in your summary will be gone.`
