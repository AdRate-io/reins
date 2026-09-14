/**
 * spill 的纯函数部分：度量一段工具输出、按 token 上限裁一段、做首尾预览。
 * 不碰存储与事件，方便单测与宿主复用；随机与时间都不在这里。
 */
import { estimateTextTokens } from "@reinsjs/core"

/** 文本 token 估算器；缺省用 core 的粗估（ASCII 4 字一 token、非 ASCII 一字一 token），宿主可注入精确 tokenizer */
export type TextTokenEstimator = (text: string) => number

export const defaultTextTokens: TextTokenEstimator = estimateTextTokens

export interface TextMeasure {
  chars: number
  lines: number
  tokens: number
}

export function measureText(text: string, estimate: TextTokenEstimator = defaultTextTokens): TextMeasure {
  return { chars: text.length, lines: countLines(text), tokens: estimate(text) }
}

/** 行数：空串算 0 行，其余按换行符数 +1（末尾换行不多算一行） */
export function countLines(text: string): number {
  if (text.length === 0) return 0
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  if (text.charCodeAt(text.length - 1) === 10) n--
  return n
}

/**
 * 从 text 开头取不超过 maxTokens 的一段（按 core 粗估的口径逐字累加：ASCII 4 字一 token、非 ASCII 一字一 token）。
 * 只在缺省估算器下精确；宿主注入了别的 estimate 时仍按这个口径裁，估算器只决定"要不要裁"。
 * 返回裁到的字符位置（== text.length 表示不用裁）。
 */
export function clipEndByTokens(text: string, maxTokens: number): number {
  let ascii = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++
    else other++
    if (Math.ceil(ascii / 4) + other > maxTokens) return i
  }
  return text.length
}

export interface PreviewOptions {
  /** 首尾各取多少行 */
  lines: number
  /** 首尾各最多多少字符（防单行超长，比如一行 JSON） */
  chars: number
}

export interface Preview {
  head: string
  /** 空串表示 head 已是全文（没有被省略的中段） */
  tail: string
  omitted: { chars: number; lines: number }
}

/** 第 n 个换行之后的位置（n 行的结束）；行不够则返回 text.length */
function offsetAfterLines(text: string, n: number): number {
  let pos = 0
  for (let i = 0; i < n; i++) {
    const nl = text.indexOf("\n", pos)
    if (nl < 0) return text.length
    pos = nl + 1
  }
  return pos
}

/** 倒数第 n 行的起点；行不够则返回 0 */
function offsetBeforeLastLines(text: string, n: number): number {
  // 末尾换行不算新行：从它前面开始数
  let pos = text.length > 0 && text.charCodeAt(text.length - 1) === 10 ? text.length - 1 : text.length
  for (let i = 0; i < n; i++) {
    const nl = text.lastIndexOf("\n", pos - 1)
    if (nl < 0) return 0
    pos = nl
  }
  return pos < text.length ? pos + 1 : pos
}

/**
 * 首尾预览：头 `lines` 行与尾 `lines` 行，各不超过 `chars` 字符。
 * 头尾在文本里重叠（文本本来就短）时 head 即全文、tail 为空；否则中段被省略并记下省略量。确定性纯函数。
 */
export function previewOf(text: string, opts: PreviewOptions): Preview {
  const headEnd = Math.min(offsetAfterLines(text, opts.lines), opts.chars)
  const tailStart = Math.max(offsetBeforeLastLines(text, opts.lines), text.length - opts.chars)
  if (tailStart <= headEnd) {
    return { head: text, tail: "", omitted: { chars: 0, lines: 0 } }
  }
  const middle = text.slice(headEnd, tailStart)
  return {
    head: text.slice(0, headEnd),
    tail: text.slice(tailStart),
    omitted: { chars: middle.length, lines: countLines(middle) },
  }
}

/** 千分位，给模型看的数字更好读 */
export function fmt(n: number): string {
  return n.toLocaleString("en-US")
}
