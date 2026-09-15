/**
 * 内联技能载体：把 SKILL.md（与附件）以字符串预填成一个只读 `SkillSource`（技术方案 §9.9）。
 *
 * 给两种宿主用：
 * - 没有文件系统的运行时（Workers）：构建期把 SKILL.md bundle 成字符串
 * - 技能正文来自别处（如 AdRate CLI 的 `skills read` 输出）：拼好头部后直接喂进来
 * 键的布局与其它载体一致：`${root}/<name>/SKILL.md`、`${root}/<name>/<附件相对路径>`。零依赖、无 I/O。
 *
 * 对象键就是技能目录名，必须匹配技能名规范且与 SKILL.md 头部的 `name` 一致——不合规的键在这里就抛错，
 * 而不是拼出一个菜单正则永远匹配不上的键让技能静默消失（发前审查抓到 `"a/b"` / `""` / `"../x"` 三种都会无声丢失）。
 */
import type { SkillSource } from "@reinsjs/core"
import { DEFAULT_SKILLS_ROOT, SKILL_FILE_NAME, SKILL_NAME_RE } from "./constants.js"

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
  const root = opts.root ?? DEFAULT_SKILLS_ROOT
  const files = new Map<string, string>()
  for (const [name, skill] of Object.entries(skills)) {
    if (!SKILL_NAME_RE.test(name)) {
      throw new RangeError(
        `inlineSkills: skill key ${JSON.stringify(name)} is not a valid skill name (it must match ${SKILL_NAME_RE.source} and equal the name in the SKILL.md front matter)`,
      )
    }
    if (typeof skill === "string") {
      files.set(`${root}/${name}/${SKILL_FILE_NAME}`, skill)
      continue
    }
    for (const [rel, content] of Object.entries(skill)) {
      const segments = rel.split("/").filter((s) => s.length > 0)
      if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) {
        throw new RangeError(
          `inlineSkills: file path ${JSON.stringify(rel)} of skill ${name} is invalid (it must be relative and contain no . or .. segments)`,
        )
      }
      files.set(`${root}/${name}/${segments.join("/")}`, content)
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
