/**
 * @reins/brain/node —— 文件系统技能载体 `fsSkillSource(dir)`（技术方案 §9.9）。brain 只有这个子路径出现 `node:*`。
 *
 * 目录布局即 Agent Skills 规范：`<dir>/<name>/SKILL.md` + 同目录附件，映射成载体键 `${root}/<name>/SKILL.md`
 * （`root` 须与 `skills({ root })` 一致，缺省 `/skills`）。只读；每次 `list` 重新遍历目录（run 起步一次，不缓存，
 * 宿主改了技能下一 run 就见到）；以 `.` 开头的文件与目录（`.git`、`.DS_Store`）不列出也读不到。
 *
 * `read` 是第二道防线：skills 模块已把模型给的路径规范化、拒绝了穿越，这里仍只接受 `${root}/` 之下、
 * 不含 `.` / `..` 段、解析后仍在 `dir` 里的路径——载体可能被宿主直接拿去用，不该依赖上游一定过滤过。
 * 不存在 / 是目录 → null（与 MemoryStore 契约一致）；其它 I/O 错误原样抛给宿主。
 */
import type { Dirent } from "node:fs"
import { readdir, readFile, realpath } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import type { SkillSource } from "@reins/core"

export interface FsSkillSourceOptions {
  /** 载体键前缀，须与 `skills({ root })` 一致；缺省 `/skills` */
  root?: string
}

const isHidden = (segment: string) => segment.startsWith(".")

export function fsSkillSource(dir: string, opts: FsSkillSourceOptions = {}): SkillSource {
  const root = opts.root ?? "/skills"
  const base = resolve(dir)

  /** `${root}/a/b` → ["a", "b"]；不在 root 下、含 `.`/`..`/空段/隐藏段 → undefined */
  const segmentsOf = (path: string): string[] | undefined => {
    if (!path.startsWith(`${root}/`)) return undefined
    const segments = path.slice(root.length + 1).split("/")
    if (segments.length === 0) return undefined
    for (const s of segments) {
      if (s.length === 0 || s === "." || s === ".." || isHidden(s) || s.includes("\\")) return undefined
    }
    return segments
  }

  return {
    async list(prefix) {
      let entries: Dirent[]
      try {
        entries = await readdir(base, { recursive: true, withFileTypes: true })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
        throw err
      }
      const keys: string[] = []
      for (const entry of entries) {
        if (!entry.isFile()) continue // 目录不列；符号链接也不列（isFile 为 false），read 侧另有 realpath 防逃逸
        // Node 22：递归 readdir 的 Dirent.parentPath 是该项所在目录的路径（绝对或相对随传入的 base）
        const full = join(entry.parentPath, entry.name)
        const rel = full.slice(base.length + 1).split(sep)
        if (rel.some(isHidden)) continue
        const key = `${root}/${rel.join("/")}`
        if (key.startsWith(prefix)) keys.push(key)
      }
      return keys.sort()
    },

    async read(path) {
      const segments = segmentsOf(path)
      if (!segments) return null
      const target = resolve(base, ...segments)
      if (!target.startsWith(`${base}${sep}`)) return null
      try {
        // 解析符号链接后仍须在目录内：技能目录里的一个链接不能把 /etc/passwd 变成"附件"
        const real = await realpath(target)
        const realBase = await realpath(base)
        if (!real.startsWith(`${realBase}${sep}`)) return null
        return await readFile(real, "utf8")
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return null
        throw err
      }
    },
  }
}
