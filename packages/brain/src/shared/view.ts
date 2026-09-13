/**
 * 带行号的文件视图（memory 的 `view` 与 skills 的 `skill_read` 共用，S1 抽出）：
 * 行号格式对齐 Anthropic memory 工具参考实现（6 位右对齐 + 制表符）；模型没指定范围时按字符上限**按行**截断，
 * 并提示用范围续读。
 *
 * 两种上限语义（`enforceLimit`）：
 * - memory（缺省 false）：截断只在模型没指定范围时做——指定了范围就是它自己在分页；单行超长也整行给
 * - skills（true）：`maxChars` 是硬上限。带范围也照样截、提示下一段从哪续；单行超过上限的按字符切开并说明。
 *   硬上限才能让 `skill_read` 对 spill 声明一个可证明的 token 上界（发前审查：`range: [1, -1]` 与单行 200k 字符都能绕过软上限）
 */

const encoder = new TextEncoder()
export const byteLength = (s: string): number => encoder.encode(s).length

/** 人读的大小：与参考实现一致用 K / M，1024 进制 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

/** 按行拆分：末尾换行不产生空行；空文件是零行 */
export function splitLines(content: string): { lines: string[]; trailingNewline: boolean } {
  if (content.length === 0) return { lines: [], trailingNewline: false }
  const trailingNewline = content.endsWith("\n")
  const body = trailingNewline ? content.slice(0, -1) : content
  return { lines: body.split("\n"), trailingNewline }
}

/** 参考实现的行号格式：6 位右对齐 + 制表符 */
export function numbered(lines: readonly string[], firstLineNo: number): string {
  return lines.map((l, i) => `${String(firstLineNo + i).padStart(6)}\t${l}`).join("\n")
}

export interface FileViewOptions {
  /** [start_line, end_line]，1-indexed 含两端；end -1 到末尾。不给则从头显示并按 maxChars 截断 */
  range?: [number, number] | undefined
  /** 正文最多的字符数（按原始行字符累计，每行加 1 个换行），超过按行截断并提示续读 */
  maxChars: number
  /** 提示续读时用的入参名（memory 是 `view_range`，skills 是 `range`） */
  rangeField: string
  /** true：maxChars 是硬上限（带范围也截、超长单行切开）。缺省 false（memory 语义） */
  enforceLimit?: boolean
}

export type FileView = { text: string; error?: undefined } | { error: string; text?: undefined }

/** 把文件正文渲染成模型看的带行号视图；范围越界给面向模型的错误 */
export function formatFileView(path: string, content: string, opts: FileViewOptions): FileView {
  const bytes = byteLength(content)
  const { lines } = splitLines(content)
  const total = lines.length
  let from = 1
  let to = total
  const range = opts.range
  if (range) {
    const [start, end] = range
    if (start > Math.max(total, 1)) {
      return {
        error: `Invalid \`${opts.rangeField}\`: start_line ${start} is beyond the end of ${path}, which has ${total} lines.`,
      }
    }
    from = start
    to = end === -1 ? total : Math.min(end, total)
  }
  const chosen = lines.slice(from - 1, to)

  let shown = chosen
  let note = ""
  if (!range || opts.enforceLimit) {
    let chars = 0
    let count = 0
    for (const l of chosen) {
      chars += l.length + 1
      if (chars > opts.maxChars && count > 0) break
      count++
    }
    if (count < chosen.length) {
      shown = chosen.slice(0, count)
      const last = from + count - 1
      note = `\n[Showing lines ${from}-${last} of ${total} (${humanSize(bytes)} total). Use ${opts.rangeField}, e.g. [${last + 1}, -1], to read the rest.]`
    }
    // 硬上限：第一行本身就超过上限时按字符切开（软上限语义下整行照给，那是 memory 的选择）
    const first = shown[0]
    if (opts.enforceLimit && first !== undefined && first.length > opts.maxChars) {
      shown = [first.slice(0, opts.maxChars)]
      note = `\n[Line ${from} is ${first.length} characters long; only the first ${opts.maxChars} are shown. Split long lines in this file to read it fully.]`
    }
  }
  const header = range
    ? `Here's the content of ${path} (lines ${from}-${to} of ${total}) with line numbers:`
    : `Here's the content of ${path} with line numbers:`
  return { text: `${header}\n${numbered(shown, from)}${note}` }
}
