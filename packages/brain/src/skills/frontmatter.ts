/**
 * SKILL.md 头部（frontmatter）解析：纯函数，菜单与 `skill_read` 共用（技术方案 §9.9）。
 *
 * 只认 Agent Skills 规范的两个必填字段 `name` / `description`，不引 YAML 库，但对齐 YAML 在这几处的语义
 * （发前审查 2026-09-13 逐条对过）：
 * - 顶层 `key: value` 逐行；`metadata:` 之下的缩进嵌套字段跳过；`allowed-tools` 等私有字段忽略
 * - 值两端的成对引号去掉（AdRate 的 SKILL.md 写成 `name: "adrate-shared"`）；` #` 起的行内注释剥掉（YAML 语义，
 *   `Use #tag` 这种紧贴的 `#` 不算注释）
 * - `description: >` / `description: |` 块标量：接下来的缩进行是值，`>` 折成一行、`|` 保留换行（菜单排版时再折）；
 *   长 description 的标准写法，不能被解析成一个字符的 `>`
 * - 重复键以后者为准（YAML 语义）；UTF-8 BOM 跳过（Windows 编辑器存的文件）
 * - `name` 须匹配 `SKILL_NAME_RE`；`description` 非空、≤ 1024 字符
 * 不合规只返回原因，由调用方决定跳过并告警——一份坏文件不该拖垮整个菜单。
 */
import { SKILL_NAME_RE } from "./constants.js"

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

/** YAML 行内注释：空白后的 `#` 起到行尾；引号里的 `#` 先由 unquote 之前的整体判断保护（引号包住的值不剥） */
function stripInlineComment(v: string): string {
  if (/^["'].*["']$/.test(v)) return v
  const m = /\s#/.exec(v)
  return m ? v.slice(0, m.index).trimEnd() : v
}

/**
 * 解析一份 SKILL.md。头部必须以 `---` 起、以 `---` 收（各占一行，允许 CRLF）。
 */
export function parseSkillMarkdown(content: string): ParsedSkill {
  let text = content.replace(/\r\n/g, "\n")
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (!text.startsWith("---\n"))
    return { ok: false, reason: "SKILL.md must start with a `---` frontmatter block" }
  // 从 index 3（首行的换行）起找 "\n---"：空头部 `---\n---` 也要认出来
  const closeAt = text.indexOf("\n---", 3)
  if (closeAt === -1) return { ok: false, reason: "frontmatter is not closed with a `---` line" }
  const afterClose = closeAt + 4
  // 收尾的 `---` 必须独占一行（后面是换行或文件末尾），否则 `----` / `--- x` 不算
  if (afterClose < text.length && text[afterClose] !== "\n") {
    return { ok: false, reason: "frontmatter is not closed with a `---` line" }
  }
  const header = text.slice(4, closeAt)
  const body = text.slice(Math.min(text.length, afterClose + 1))

  const fields = new Map<string, string>()
  const lines = header.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue
    if (/^\s/.test(line)) continue // 嵌套字段（metadata: 之下），不认
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    const rawValue = stripInlineComment(line.slice(colon + 1).trim())
    if (rawValue === ">" || rawValue === "|" || rawValue === ">-" || rawValue === "|-") {
      // 块标量：吃掉后续的缩进行
      const parts: string[] = []
      while (
        i + 1 < lines.length &&
        (/^\s/.test(lines[i + 1] as string) || (lines[i + 1] as string).trim() === "")
      ) {
        i++
        parts.push((lines[i] as string).trim())
      }
      while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop()
      fields.set(key, rawValue.startsWith(">") ? parts.join(" ") : parts.join("\n"))
      continue
    }
    fields.set(key, unquote(rawValue)) // 重复键以后者为准
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
