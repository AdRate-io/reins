/**
 * skills 模块给模型看的文字（技术方案 §9.9）：工具说明、规则提示、菜单排版。
 *
 * 渐进式披露的两层：系统提示里只有菜单（每个技能的 name + description），正文要模型自己用 `skill_read` 翻——
 * 读哪份、什么时候读是模型的判断（宪法一），规则只给经验：有相关技能先读再动手、读过的不重读、附件按需读。
 * 作为 Socket 的静态 systemPrompt 片段追加在宿主提示之后，整个 run 逐字不变（§9.1 约束 3）。英文：进的是模型上下文。
 */

export const SKILL_READ_TOOL_NAME = "skill_read"

export const SKILL_READ_TOOL_DESCRIPTION = [
  "Read a skill: an instruction document the host prepared for a kind of task.",
  "`name` is the skill's name from the Skills list; `path` (default `SKILL.md`) selects a supporting file the skill refers to, relative to the skill's folder.",
  "Long files are shown from the top with line numbers and a note on how much is left; pass `range: [start_line, end_line]` (1-indexed, `end_line` -1 means to the end) to read the rest.",
].join(" ")

/** 规则提示的经验部分；菜单由 renderSkillMenu 排在其后 */
export const SKILL_RULES = `## Skills
Skills are instruction documents the host wrote for specific kinds of work. Each entry below is only a name and a one-line description; the instructions themselves are not loaded until you read them.
- Before starting on a task a skill covers, read it with \`${SKILL_READ_TOOL_NAME}({ name })\` and follow it. Read a skill's supporting files (\`path\`) only when the skill points you to them.
- A skill you have already read in this conversation stays in your context; do not read it again unless it has been folded away.
- Do not guess what an unread skill says. If no skill fits the task, proceed without one.`

export interface SkillMenuEntry {
  name: string
  description: string
}

/** 菜单：每项一行 `- name: description`（description 里的换行折成空格，菜单保持一行一项） */
export function renderSkillMenu(entries: readonly SkillMenuEntry[]): string {
  const lines = entries.map((e) => `- ${e.name}: ${e.description.replace(/\s*\n\s*/g, " ")}`)
  return `Available skills:\n${lines.join("\n")}`
}

export const SKILL_READ_INPUT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "The skill's name, exactly as listed under Skills." },
    path: {
      type: "string",
      description: "File to read inside the skill's folder, relative to it. Default SKILL.md.",
    },
    range: {
      type: "array",
      items: { type: "integer" },
      minItems: 2,
      maxItems: 2,
      description:
        "[start_line, end_line], 1-indexed and inclusive; end_line -1 means to the end of the file.",
    },
  },
  required: ["name"],
  additionalProperties: false,
} as const
