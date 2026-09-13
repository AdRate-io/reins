/**
 * 内联技能载体：把 SKILL.md（与附件）以字符串预填成一个只读 `SkillSource`（技术方案 §9.9）。
 *
 * 给两种宿主用：
 * - 没有文件系统的运行时（Workers）：构建期把 SKILL.md bundle 成字符串
 * - 技能正文来自别处（如 AdRate CLI 的 `skills read` 输出）：拼好头部后直接喂进来
 * 键的布局与其它载体一致：`${root}/<name>/SKILL.md`、`${root}/<name>/<附件相对路径>`。零依赖、无 I/O。
 */
import type { SkillSource } from "@reins/core"

/** 一个技能：直接给 SKILL.md 全文，或给 `{ "SKILL.md": ..., "reference.md": ... }` 一组文件 */
export type InlineSkill = string | Readonly<Record<string, string>>

export interface InlineSkillsOptions {
  /** 键前缀，须与 `skills({ root })` 一致；缺省 `/skills` */
  root?: string
}

export function inlineSkills(
  skills: Readonly<Record<string, InlineSkill>>,
  opts: InlineSkillsOptions = {},
): SkillSource {
  const root = opts.root ?? "/skills"
  const files = new Map<string, string>()
  for (const [name, skill] of Object.entries(skills)) {
    if (typeof skill === "string") {
      files.set(`${root}/${name}/SKILL.md`, skill)
      continue
    }
    for (const [rel, content] of Object.entries(skill)) {
      const clean = rel
        .split("/")
        .filter((s) => s.length > 0)
        .join("/")
      files.set(`${root}/${name}/${clean}`, content)
    }
  }
  return {
    async list(prefix) {
      return [...files.keys()].filter((k) => k.startsWith(prefix)).sort()
    },
    async read(path) {
      return files.get(path) ?? null
    },
  }
}
