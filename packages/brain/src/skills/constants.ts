/**
 * skills 模块的字面常量，单独成文件、零依赖：`@reinsjs/brain/node` 的 fsSkillSource 也要用同一份 `/skills`，
 * 而它不能把整个 skills 模块拖进 `dist/node.js`（"同一个值在两处必须同一份"，踩坑记录）。
 */

/** 载体里技能的键前缀缺省值：`${root}/<name>/SKILL.md` */
export const DEFAULT_SKILLS_ROOT = "/skills"

/** 每个技能目录里的入口文件名（Agent Skills 规范固定，不可配） */
export const SKILL_FILE_NAME = "SKILL.md"

/** 技能名：小写字母 / 数字 / 连字符，64 字符内，须与目录名一致（Agent Skills 规范） */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
