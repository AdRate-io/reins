/**
 * SKILL.md 头部（frontmatter）解析：纯函数，菜单与 `skill_read` 共用（技术方案 §9.9）。
 *
 * 只认 Agent Skills 规范的两个必填字段 `name` / `description`，逐行 `key: value`，不引 YAML 库：
 * - 缩进行（如 `metadata:` 下的嵌套字段）、空行、`#` 注释一律跳过；`allowed-tools` 等私有字段忽略
 * - 值两端的成对引号去掉（AdRate 的 SKILL.md 写成 `name: "adrate-shared"`）
 * - `name` 须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`（小写字母 / 数字 / 连字符，64 字符内）；`description` 非空、≤ 1024 字符
 * 不合规只返回原因，由调用方决定跳过并告警——一份坏文件不该拖垮整个菜单。
 */

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const MAX_SKILL_DESCRIPTION_CHARS = 1024

export interface SkillFrontmatter {
  name: string
  description: string
  /** 头部之后的正文（不含分隔线） */
  body: string
}

export type ParsedSkill = { ok: true; skill: SkillFrontmatter } | { ok: false; reason: string }

/** 去掉成对的首尾引号（单双都认）；不成对就原样返回 */
function unquote(v: string): string {
  if (v.length >= 2) {
    const a = v[0]
    const b = v[v.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return v.slice(1, -1)
  }
  return v
}

/**
 * 解析一份 SKILL.md。头部必须以 `---` 起、以 `---` 收（各占一行，允许 CRLF）。
 */
export function parseSkillMarkdown(content: string): ParsedSkill {
  const text = content.replace(/\r\n/g, "\n")
  if (!text.startsWith("---\n"))
    return { ok: false, reason: "SKILL.md must start with a `---` frontmatter block" }
  const closeAt = text.indexOf("\n---", 4)
  if (closeAt === -1) return { ok: false, reason: "frontmatter is not closed with a `---` line" }
  const afterClose = closeAt + 4
  // 收尾的 `---` 必须独占一行（后面是换行或文件末尾），否则 `----` / `--- x` 不算
  if (afterClose < text.length && text[afterClose] !== "\n") {
    return { ok: false, reason: "frontmatter is not closed with a `---` line" }
  }
  const header = text.slice(4, closeAt)
  const body = text.slice(Math.min(text.length, afterClose + 1))

  const fields = new Map<string, string>()
  for (const line of header.split("\n")) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue
    if (/^\s/.test(line)) continue // 嵌套字段（metadata: 之下），不认
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    const value = unquote(line.slice(colon + 1).trim())
    if (!fields.has(key)) fields.set(key, value)
  }

  const name = fields.get("name")
  if (name === undefined || name.length === 0) return { ok: false, reason: "frontmatter has no `name`" }
  if (!SKILL_NAME_RE.test(name)) {
    return {
      ok: false,
      reason: `\`name\` ${JSON.stringify(name)} must match ${SKILL_NAME_RE.source} (lowercase letters, digits, hyphens; at most 64 characters)`,
    }
  }
  const description = fields.get("description")
  if (description === undefined || description.length === 0) {
    return { ok: false, reason: "frontmatter has no `description`" }
  }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    return {
      ok: false,
      reason: `\`description\` is ${description.length} characters; at most ${MAX_SKILL_DESCRIPTION_CHARS} allowed`,
    }
  }
  return { ok: true, skill: { name, description, body } }
}
