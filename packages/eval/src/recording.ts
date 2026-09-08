/**
 * 把一段真实录像整理成能公开、能回放的 fixture 素材（E2）。两件事：
 *
 * 1. **去外溢（unspill）**：录制时 spill 模块把大结果外溢进 BlobStore，日志里只剩预览与 blob id；
 *    但模型随后用 fetch_blob 分段取回的全文也在日志里。把这些分片按字符偏移拼回去，就能在不碰原 BlobStore 的前提下
 *    还原完整的工具结果 —— fixture 里的"世界"必须是完整的，不然无脑子臂拿到的是一段预览加一个取不回的 id。
 *    拼不齐（模型当时没读完）的原样保留并报告，不硬凑。
 * 2. **脱敏（scrub）**：按"原文 → 别名"表对每条事件做逐字替换，长的先换，替换在 JSON 文本层进行，
 *    所以入参、结果、模型正文、思考里出现的同一个值一起变，回放时模型看到的 id 与它要传给工具的 id 仍然一致。
 *    每条规则命中几次会报告出来（不含原文），零命中的规则说明表写错了。
 *
 * 本文件是纯函数、零 node:*；读写文件与决定"哪些字段算敏感"由调用方（examples/eval 的 build 脚本）负责。
 */
import type { ContentPart, CoreEventOf, Event } from "@reins/core"

// ---- 去外溢 ----

export interface UnspillOptions {
  /** 还原后是否把 fetch_blob 的调用 / 结果对从录像里删掉（它们是脑子的动作，不是世界的一部分）；缺省 true */
  dropFetchBlob?: boolean
  /** fetch_blob 工具名；缺省 "fetch_blob" */
  fetchToolName?: string
}

export interface UnspillResult {
  events: Event[]
  /** 成功还原全文的 blob id */
  restored: string[]
  /** 分片拼不齐（有缺口或没读到末尾）的 blob id，其 tool_result 原样保留 */
  incomplete: string[]
  /** 删掉的 fetch_blob 调用 / 结果对数 */
  droppedFetches: number
}

interface BlobChunk {
  start: number
  end: number
  total: number
  text: string
}

/** fetch_blob 结果头：`[blob "<id>": characters 0–23,421 of 39,980 (1 lines total)...]` 后跟一个换行与正文 */
const FETCH_HEADER =
  /^\[blob "([^"]+)": characters ([\d,]+)–([\d,]+) of ([\d,]+) \([\d,]+ lines total\)[^\]]*\]\n?/

const num = (s: string) => Number(s.replace(/,/g, ""))

export function parseFetchChunk(text: string): (BlobChunk & { id: string }) | undefined {
  const m = FETCH_HEADER.exec(text)
  if (!m) return undefined
  const [header, id, start, end, total] = m as unknown as [string, string, string, string, string]
  return { id, start: num(start), end: num(end), total: num(total), text: text.slice(header.length) }
}

/** 按偏移把分片拼成全文；重叠部分取先到者，有缺口或没到末尾返回 undefined */
export function assembleChunks(chunks: readonly BlobChunk[]): string | undefined {
  if (chunks.length === 0) return undefined
  const total = (chunks[0] as BlobChunk).total
  const sorted = [...chunks].sort((a, b) => a.start - b.start)
  let cursor = 0
  let out = ""
  for (const c of sorted) {
    if (c.total !== total) return undefined
    if (c.start > cursor) return undefined
    // 分片声明的区间与正文长度不符（被裁过又没改头）就不信它
    if (c.text.length !== c.end - c.start) return undefined
    if (c.end > cursor) {
      out += c.text.slice(cursor - c.start)
      cursor = c.end
    }
  }
  return cursor === total ? out : undefined
}

const textOf = (content: readonly ContentPart[]) =>
  content.map((p) => (p.type === "text" ? p.text : "")).join("")

export function unspillRecording(recording: readonly Event[], opts: UnspillOptions = {}): UnspillResult {
  const fetchName = opts.fetchToolName ?? "fetch_blob"
  const dropFetch = opts.dropFetchBlob ?? true

  // 1. 收集 fetch_blob 分片，按 blob id 归堆
  const chunks = new Map<string, BlobChunk[]>()
  const fetchCallIds = new Set<string>()
  for (const e of recording) {
    if (e.type === "core.tool_call" && (e as CoreEventOf<"core.tool_call">).payload.name === fetchName) {
      fetchCallIds.add((e as CoreEventOf<"core.tool_call">).payload.toolCallId)
      continue
    }
    if (e.type !== "core.tool_result") continue
    const r = e as CoreEventOf<"core.tool_result">
    if (r.payload.name !== fetchName || r.payload.isError) continue
    const chunk = parseFetchChunk(textOf(r.payload.content))
    if (!chunk) continue
    const list = chunks.get(chunk.id) ?? []
    list.push(chunk)
    chunks.set(chunk.id, list)
  }

  // 2. 逐条外溢结果试着还原
  const restored: string[] = []
  const incomplete: string[] = []
  const events: Event[] = []
  let droppedFetches = 0
  for (const e of recording) {
    if (dropFetch) {
      if (
        e.type === "core.tool_call" &&
        fetchCallIds.has((e as CoreEventOf<"core.tool_call">).payload.toolCallId)
      ) {
        droppedFetches++
        continue
      }
      if (
        e.type === "core.tool_result" &&
        fetchCallIds.has((e as CoreEventOf<"core.tool_result">).payload.toolCallId)
      )
        continue
    }
    if (e.type !== "core.tool_result") {
      events.push(e)
      continue
    }
    const r = e as CoreEventOf<"core.tool_result">
    const spilled = r.payload.spilled
    if (!spilled) {
      events.push(e)
      continue
    }
    const full = assembleChunks(chunks.get(spilled.blobId) ?? [])
    if (full === undefined) {
      incomplete.push(spilled.blobId)
      events.push(e)
      continue
    }
    restored.push(spilled.blobId)
    const { spilled: _drop, ...payload } = r.payload
    events.push({ ...r, payload: { ...payload, content: [{ type: "text", text: full }] } } as Event)
  }
  return { events, restored, incomplete, droppedFetches }
}

// ---- 脱敏 ----

export type Replacement = readonly [from: string, to: string]

export interface ScrubResult {
  events: Event[]
  /** 每条规则命中的次数，与传入顺序一致（不含原文，可以放进报告） */
  hits: number[]
}

/** JSON 文本里的写法：值出现在字符串字面量里时引号与反斜杠是转义过的，替换双方都要按同样写法 */
const jsonForm = (s: string) => JSON.stringify(s).slice(1, -1)

/**
 * 对每条事件的 JSON 文本做逐字替换（长的 from 先换，避免短串把长串拆坏），再解析回事件。
 * 事件的 id / sessionId / seq 等结构字段同样会被替换 —— 调用方若不想动它们，别把那些值放进表里。
 */
export function scrubEvents(events: readonly Event[], replacements: readonly Replacement[]): ScrubResult {
  const ordered = replacements
    .map((r, i) => ({ from: jsonForm(r[0]), to: jsonForm(r[1]), i }))
    .filter((r) => r.from.length > 0)
    .sort((a, b) => b.from.length - a.from.length)
  const hits = replacements.map(() => 0)
  const out: Event[] = []
  for (const e of events) {
    let text = JSON.stringify(e)
    for (const r of ordered) {
      const parts = text.split(r.from)
      if (parts.length === 1) continue
      hits[r.i] = (hits[r.i] ?? 0) + parts.length - 1
      text = parts.join(r.to)
    }
    out.push(JSON.parse(text) as Event)
  }
  return { events: out, hits }
}

/** 去重保序，给每个不同的值起一个别名；alias 收到的 index 从 1 起 */
export function aliasTable(
  values: Iterable<string>,
  alias: (index: number, value: string) => string,
): Replacement[] {
  const seen = new Set<string>()
  const out: Replacement[] = []
  for (const v of values) {
    if (v === "" || seen.has(v)) continue
    seen.add(v)
    out.push([v, alias(out.length + 1, v)])
  }
  return out
}

/** 在事件的 JSON 文本里按正则找值（如 19 位广告主 id），按出现顺序去重返回 */
export function matchStrings(events: readonly Event[], pattern: RegExp): string[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
  const re = new RegExp(pattern.source, flags)
  const seen = new Set<string>()
  const out: string[] = []
  for (const e of events) {
    const text = JSON.stringify(e)
    for (const m of text.matchAll(re)) {
      const v = m[0]
      if (!seen.has(v)) {
        seen.add(v)
        out.push(v)
      }
    }
  }
  return out
}

/**
 * 收集事件里指定键名的字符串值：遍历 payload，工具结果的文本部分若是 JSON 也解析后一起遍历
 * （AdRate 这类信封工具把整个响应放在一段文本里）。按出现顺序去重。
 */
export function jsonValuesAt(events: readonly Event[], keys: readonly string[]): string[] {
  const want = new Set(keys)
  const seen = new Set<string>()
  const out: string[] = []
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x)
      return
    }
    if (v === null || typeof v !== "object") return
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (want.has(k) && typeof x === "string" && x !== "" && !seen.has(x)) {
        seen.add(x)
        out.push(x)
      }
      if (k === "text" && typeof x === "string") {
        const parsed = tryParseJson(x)
        if (parsed !== undefined) visit(parsed)
      }
      visit(x)
    }
  }
  for (const e of events) visit(e.payload)
  return out
}

function tryParseJson(text: string): unknown {
  const t = text.trimStart()
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}
