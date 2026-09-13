/**
 * memory 工具的六个 command：入参解析 + 在 MemoryStore 上执行（技术方案 §9.6）。
 *
 * 形状与返回文案对齐 Anthropic `memory_20250818` 的参考实现（platform.claude.com/docs/.../memory-tool），
 * 让模型已有的使用习惯直接迁移；差异只在几处更诚实或更安全的地方：
 * - `create` 对已存在的文件是**覆盖**（工具说明本来就写"creates or overwrites"），回执里说明替换了旧内容
 * - `view` 超长文件按字符上限截断并提示用 `view_range` 续读；写类操作有单文件大小上限
 * - 目录在 KV 式存储里是隐含的（有以它为前缀的文件就算存在），所以 `create` 到目录路径、对目录 `str_replace` 都报错
 *
 * 全部是纯的存储操作，不知道 Socket / 事件 / 命名空间：命名空间由 memory.ts 用 `bindMemoryFs` 包一层。
 * `rename` 目录与 `delete` 目录不是原子的（MemoryStore 没有事务）；顺序都是"先写后删"，中途失败最多多出重复，不会丢。
 */
import type { MemoryStore } from "@reins/core"
import { byteLength, formatFileView, humanSize, numbered, splitLines } from "../shared/view.js"
import { isUnder, MEMORY_ROOT, resolveMemoryPath } from "./paths.js"

// 度量与行号格式在 ../shared/view.ts（与 skills 共用，S1 抽出）；这里再导出是为了不改本模块的公开面
export { byteLength, humanSize }

export type MemoryOp = "view" | "create" | "str_replace" | "insert" | "delete" | "rename"

export type MemoryCommand =
  | { command: "view"; path: string; viewRange?: [number, number] }
  | { command: "create"; path: string; fileText: string }
  | { command: "str_replace"; path: string; oldStr: string; newStr: string }
  | { command: "insert"; path: string; insertLine: number; insertText: string }
  | { command: "delete"; path: string }
  | { command: "rename"; oldPath: string; newPath: string }

export const MEMORY_COMMANDS: readonly MemoryOp[] = [
  "view",
  "create",
  "str_replace",
  "insert",
  "delete",
  "rename",
]

export const MEMORY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: MEMORY_COMMANDS,
      description: "The operation to perform.",
    },
    path: {
      type: "string",
      description: "Absolute path under /memories. Used by every command except rename.",
    },
    view_range: {
      type: "array",
      items: { type: "integer" },
      minItems: 2,
      maxItems: 2,
      description:
        "view only: [start_line, end_line], 1-indexed and inclusive; end_line -1 means to the end of the file.",
    },
    file_text: { type: "string", description: "create: the full content of the file." },
    old_str: {
      type: "string",
      description: "str_replace: the exact text to replace; it must occur exactly once in the file.",
    },
    new_str: { type: "string", description: "str_replace: the replacement text. Omit to delete old_str." },
    insert_line: {
      type: "integer",
      minimum: 0,
      description: "insert: insert after this line number; 0 inserts at the top of the file.",
    },
    insert_text: { type: "string", description: "insert: the text to insert." },
    old_path: { type: "string", description: "rename: the current path." },
    new_path: { type: "string", description: "rename: the new path; it must not exist yet." },
  },
  required: ["command"],
  additionalProperties: false,
} as const

/** 解析并校验模型给的入参：路径在这里就规范化（防穿越），字段缺失或类型不对抛 RangeError */
export function parseMemoryCommand(raw: unknown): MemoryCommand {
  if (typeof raw !== "object" || raw === null)
    throw new RangeError("memory expects an object with a `command`")
  const o = raw as Record<string, unknown>
  const command = o.command
  if (typeof command !== "string" || !(MEMORY_COMMANDS as readonly string[]).includes(command)) {
    throw new RangeError(
      `Unknown \`command\` ${JSON.stringify(command)}; expected one of ${MEMORY_COMMANDS.join(", ")}`,
    )
  }
  const op = command as MemoryOp
  const str = (key: string): string => {
    if (typeof o[key] !== "string")
      throw new RangeError(`\`${key}\` is required for ${op} and must be a string`)
    return o[key] as string
  }

  switch (op) {
    case "view": {
      const path = resolveMemoryPath(o.path)
      if (o.view_range === undefined) return { command: op, path }
      const r = o.view_range
      if (!Array.isArray(r) || r.length !== 2 || !r.every((n) => Number.isInteger(n))) {
        throw new RangeError("`view_range` must be [start_line, end_line] with integer values")
      }
      const [start, end] = r as [number, number]
      if (start < 1) throw new RangeError("`view_range` start_line must be ≥ 1")
      if (end !== -1 && end < start)
        throw new RangeError("`view_range` end_line must be ≥ start_line, or -1 for the end")
      return { command: op, path, viewRange: [start, end] }
    }
    case "create":
      return { command: op, path: resolveMemoryPath(o.path), fileText: str("file_text") }
    case "str_replace": {
      const oldStr = str("old_str")
      if (oldStr.length === 0) throw new RangeError("`old_str` must not be empty")
      if (o.new_str !== undefined && typeof o.new_str !== "string")
        throw new RangeError("`new_str` must be a string")
      return {
        command: op,
        path: resolveMemoryPath(o.path),
        oldStr,
        newStr: (o.new_str as string | undefined) ?? "",
      }
    }
    case "insert": {
      if (!Number.isInteger(o.insert_line) || (o.insert_line as number) < 0) {
        throw new RangeError("`insert_line` is required for insert and must be an integer ≥ 0")
      }
      return {
        command: op,
        path: resolveMemoryPath(o.path),
        insertLine: o.insert_line as number,
        insertText: str("insert_text"),
      }
    }
    case "delete":
      return { command: op, path: resolveMemoryPath(o.path) }
    case "rename":
      return {
        command: op,
        oldPath: resolveMemoryPath(o.old_path, "old_path"),
        newPath: resolveMemoryPath(o.new_path, "new_path"),
      }
  }
}

// ---- 存储适配 ----

/** 命令执行看到的存储：路径都是模型可见形态（/memories/...），命名空间在这层之下 */
export interface MemoryFs {
  read(path: string): Promise<string | null>
  write(path: string, content: string): Promise<void>
  delete(path: string): Promise<void>
  /** 目录下任意深度的全部文件路径，字典序 */
  listUnder(dir: string): Promise<string[]>
}

/**
 * 把 MemoryStore 绑到一个命名空间前缀上：存储里的键 = prefix + 模型可见路径。
 * 多用户宿主用它给每个 principal 一块独立的 /memories（`memory({ namespace })`）。
 */
export function bindMemoryFs(store: MemoryStore, prefix = ""): MemoryFs {
  return {
    read: (path) => store.read(prefix + path),
    write: (path, content) => store.write(prefix + path, content),
    delete: (path) => store.delete(prefix + path),
    async listUnder(dir) {
      const keyPrefix = `${prefix}${dir}/`
      const keys = await store.list(keyPrefix)
      // list 按前缀过滤是存储契约；再过一遍是防后端把 "/memories/a" 也算进 "/memories/" 之类的宽松实现
      return keys
        .filter((k) => k.startsWith(keyPrefix))
        .map((k) => k.slice(prefix.length))
        .sort()
    },
  }
}

// ---- 执行 ----

export interface MemoryLimits {
  /** 单文件上限（UTF-8 字节）：create / str_replace / insert 写出的结果超过即拒绝 */
  maxFileBytes: number
  /** view 单次最多返回的字符数（正文部分）；超过按行截断并提示用 view_range 续读 */
  maxViewChars: number
}

export interface MemoryOutcome {
  /** 给模型看的文字 */
  text: string
  isError: boolean
  /** 成功时的留痕要素（memory_op 载荷）；失败为 undefined */
  op?: { op: MemoryOp; path: string; toPath?: string; bytes?: number }
}

/** 某个字符偏移落在第几行（1-indexed） */
function lineOfOffset(content: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset; i++) if (content.charCodeAt(i) === 10) line++
  return line
}

/** 编辑点附近的片段（前后各 context 行），供模型核对改动 */
function snippetAround(content: string, centerLine: number, spanLines: number, context = 4): string {
  const { lines } = splitLines(content)
  const from = Math.max(1, centerLine - context)
  const to = Math.min(lines.length, centerLine + spanLines - 1 + context)
  return numbered(lines.slice(from - 1, to), from)
}

const ok = (text: string, op: NonNullable<MemoryOutcome["op"]>): MemoryOutcome => ({
  text,
  isError: false,
  op,
})
const fail = (text: string): MemoryOutcome => ({ text, isError: true })
const notFound = (path: string) => fail(`The path ${path} does not exist. Please provide a valid path.`)

async function isDirectory(fs: MemoryFs, path: string): Promise<boolean> {
  if (path === MEMORY_ROOT) return true
  return (await fs.listUnder(path)).length > 0
}

/** 读文件供编辑：不存在 / 是目录都给出面向模型的解释 */
async function readForEdit(
  fs: MemoryFs,
  path: string,
): Promise<{ content: string } | { error: MemoryOutcome }> {
  const content = await fs.read(path)
  if (content !== null) return { content }
  if (await isDirectory(fs, path))
    return { error: fail(`Error: The path ${path} is a directory, not a file.`) }
  return { error: fail(`Error: The path ${path} does not exist. Please provide a valid path.`) }
}

function checkSize(path: string, content: string, limits: MemoryLimits): MemoryOutcome | undefined {
  const size = byteLength(content)
  if (size <= limits.maxFileBytes) return undefined
  return fail(
    `Error: The resulting file ${path} would be ${humanSize(size)} (${size} bytes); memory files are limited to ${humanSize(limits.maxFileBytes)}. Split it into smaller files or keep only what a future session will need.`,
  )
}

export async function executeMemoryCommand(
  fs: MemoryFs,
  cmd: MemoryCommand,
  limits: MemoryLimits,
): Promise<MemoryOutcome> {
  switch (cmd.command) {
    case "view":
      return view(fs, cmd.path, cmd.viewRange, limits)
    case "create":
      return create(fs, cmd.path, cmd.fileText, limits)
    case "str_replace":
      return strReplace(fs, cmd.path, cmd.oldStr, cmd.newStr, limits)
    case "insert":
      return insert(fs, cmd.path, cmd.insertLine, cmd.insertText, limits)
    case "delete":
      return remove(fs, cmd.path)
    case "rename":
      return rename(fs, cmd.oldPath, cmd.newPath)
  }
}

async function view(
  fs: MemoryFs,
  path: string,
  range: [number, number] | undefined,
  limits: MemoryLimits,
): Promise<MemoryOutcome> {
  const content = await fs.read(path)
  if (content === null) {
    if (!(await isDirectory(fs, path))) return notFound(path)
    return listing(fs, path)
  }
  const v = formatFileView(path, content, { range, maxChars: limits.maxViewChars, rangeField: "view_range" })
  if (v.error !== undefined) return fail(v.error)
  return ok(v.text, { op: "view", path, bytes: byteLength(content) })
}

/** 目录列表：最多两层深，目录只列名字与合计大小，与参考实现的格式一致（大小 TAB 路径） */
async function listing(fs: MemoryFs, dir: string): Promise<MemoryOutcome> {
  const files = await fs.listUnder(dir)
  const sizes = new Map<string, number>()
  await Promise.all(
    files.map(async (f) => {
      sizes.set(f, byteLength((await fs.read(f)) ?? ""))
    }),
  )
  // 条目：一层与两层深的文件原样列出；更深的归并到它所在的两层目录
  const entries = new Map<string, number>()
  let total = 0
  for (const f of files) {
    const size = sizes.get(f) ?? 0
    total += size
    const rel = f.slice(dir.length + 1).split("/")
    const first = `${dir}/${rel[0]}`
    if (rel.length === 1) {
      entries.set(first, size)
      continue
    }
    entries.set(first, (entries.get(first) ?? 0) + size)
    const second = `${first}/${rel[1]}`
    if (rel.length >= 2) entries.set(second, (entries.get(second) ?? 0) + size)
  }
  const rows = [`${humanSize(total)}\t${dir}`]
  for (const p of [...entries.keys()].sort()) rows.push(`${humanSize(entries.get(p) ?? 0)}\t${p}`)
  return ok(`Here're the files and directories up to 2 levels deep in ${dir}:\n${rows.join("\n")}`, {
    op: "view",
    path: dir,
  })
}

async function create(
  fs: MemoryFs,
  path: string,
  fileText: string,
  limits: MemoryLimits,
): Promise<MemoryOutcome> {
  if (path === MEMORY_ROOT) return fail(`Error: ${MEMORY_ROOT} is the memory root directory, not a file.`)
  const existing = await fs.read(path)
  if (existing === null && (await isDirectory(fs, path))) {
    return fail(`Error: ${path} is a directory; choose a file path inside it or elsewhere.`)
  }
  const tooBig = checkSize(path, fileText, limits)
  if (tooBig) return tooBig
  await fs.write(path, fileText)
  const bytes = byteLength(fileText)
  return ok(
    existing === null
      ? `File created successfully at: ${path}`
      : `File created successfully at: ${path} (replaced the previous content)`,
    { op: "create", path, bytes },
  )
}

async function strReplace(
  fs: MemoryFs,
  path: string,
  oldStr: string,
  newStr: string,
  limits: MemoryLimits,
): Promise<MemoryOutcome> {
  const r = await readForEdit(fs, path)
  if ("error" in r) return r.error
  const { content } = r
  const hits: number[] = []
  for (let i = content.indexOf(oldStr); i !== -1; i = content.indexOf(oldStr, i + oldStr.length)) hits.push(i)
  if (hits.length === 0) {
    return fail(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${path}.`)
  }
  if (hits.length > 1) {
    const lines = hits.map((h) => lineOfOffset(content, h)).join(", ")
    return fail(
      `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lines}. Please ensure it is unique`,
    )
  }
  const at = hits[0] as number
  const next = content.slice(0, at) + newStr + content.slice(at + oldStr.length)
  const tooBig = checkSize(path, next, limits)
  if (tooBig) return tooBig
  await fs.write(path, next)
  const line = lineOfOffset(next, at)
  const span = Math.max(1, newStr.split("\n").length)
  return ok(
    `The memory file has been edited.\nHere's a snippet of ${path} around the edit:\n${snippetAround(next, line, span)}`,
    { op: "str_replace", path, bytes: byteLength(next) },
  )
}

async function insert(
  fs: MemoryFs,
  path: string,
  insertLine: number,
  insertText: string,
  limits: MemoryLimits,
): Promise<MemoryOutcome> {
  const r = await readForEdit(fs, path)
  if ("error" in r) return r.error
  const { lines, trailingNewline } = splitLines(r.content)
  if (insertLine > lines.length) {
    return fail(
      `Error: Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`,
    )
  }
  const inserted = (insertText.endsWith("\n") ? insertText.slice(0, -1) : insertText).split("\n")
  lines.splice(insertLine, 0, ...inserted)
  // 原文件末尾有换行就保留这个习惯；空文件插入后按有换行结尾算（下一次 insert 才不会把它当一行拼接）
  const next = lines.join("\n") + (trailingNewline || r.content.length === 0 ? "\n" : "")
  const tooBig = checkSize(path, next, limits)
  if (tooBig) return tooBig
  await fs.write(path, next)
  return ok(
    `The file ${path} has been edited.\nHere's a snippet of ${path} around the edit:\n${snippetAround(next, insertLine + 1, inserted.length)}`,
    { op: "insert", path, bytes: byteLength(next) },
  )
}

async function remove(fs: MemoryFs, path: string): Promise<MemoryOutcome> {
  if (path === MEMORY_ROOT) {
    return fail(
      `Error: The memory root ${MEMORY_ROOT} cannot be deleted. Delete individual files or directories under it.`,
    )
  }
  const content = await fs.read(path)
  if (content !== null) {
    await fs.delete(path)
    return ok(`Successfully deleted ${path}`, { op: "delete", path, bytes: byteLength(content) })
  }
  const children = await fs.listUnder(path)
  if (children.length === 0) return fail(`Error: The path ${path} does not exist`)
  let bytes = 0
  for (const child of children) {
    bytes += byteLength((await fs.read(child)) ?? "")
    await fs.delete(child)
  }
  return ok(`Successfully deleted ${path} (${children.length} files)`, { op: "delete", path, bytes })
}

async function rename(fs: MemoryFs, oldPath: string, newPath: string): Promise<MemoryOutcome> {
  if (oldPath === MEMORY_ROOT) return fail(`Error: The memory root ${MEMORY_ROOT} cannot be renamed.`)
  if (newPath === MEMORY_ROOT) return fail(`Error: The destination ${MEMORY_ROOT} is the memory root.`)
  if (oldPath === newPath) return fail(`Error: old_path and new_path are the same: ${oldPath}`)
  if ((await fs.read(newPath)) !== null || (await isDirectory(fs, newPath))) {
    return fail(`Error: The destination ${newPath} already exists`)
  }

  const content = await fs.read(oldPath)
  if (content !== null) {
    // 先写后删：中途失败最多留下重复，不会丢
    await fs.write(newPath, content)
    await fs.delete(oldPath)
    return ok(`Successfully renamed ${oldPath} to ${newPath}`, {
      op: "rename",
      path: oldPath,
      toPath: newPath,
      bytes: byteLength(content),
    })
  }

  const children = await fs.listUnder(oldPath)
  if (children.length === 0) return fail(`Error: The path ${oldPath} does not exist`)
  if (isUnder(oldPath, newPath)) return fail(`Error: Cannot move ${oldPath} into itself (${newPath})`)
  let bytes = 0
  for (const child of children) {
    const text = (await fs.read(child)) ?? ""
    bytes += byteLength(text)
    await fs.write(newPath + child.slice(oldPath.length), text)
    await fs.delete(child)
  }
  return ok(`Successfully renamed ${oldPath} to ${newPath} (${children.length} files)`, {
    op: "rename",
    path: oldPath,
    toPath: newPath,
    bytes,
  })
}
