/**
 * 被折叠工具结果的清单（E3c）。
 *
 * 整理（模型自决或阈值兜底）把一段历史换成摘要后，原件仍在日志里（宪法二），但模型不知道**有什么**能拿回来：
 * 两个模型族的实测都把"复核过的字段值"整理成了"状态正常"一句结论，被问到时只能说"没留，可以重查"。
 * 这里把被折叠范围内的每条工具结果列成 `seq N tool(arguments)` 一行，附在摘要之后 —— 摘要写的是模型的取舍，
 * 清单写的是事实上还在的东西。取回的动作由脑子的 recall 工具做（@reins/brain），core 只负责列清单，措辞由调用方给。
 *
 * 纯函数：同一输入同一输出，摘要文本落在 compaction 事件里，回放时逐字一致。
 */
import type { ContentPart, Event } from "../events/base.js"
import type { CoreEventOf } from "../events/core.js"

export interface FoldedToolResult {
  /** tool_result 事件的 seq —— 模型取回时报这个号 */
  seq: number
  name: string
  /** 对应 tool_call 的入参；找不到 tool_call 时为 undefined */
  args: unknown
  /** 结果正文（文本片段）的字符数；外溢过的结果只算留下的预览 */
  chars: number
  isError: boolean
  /** 结果已外溢到 BlobStore 时的 blob id：原件在 blob 里，不在事件里 */
  spilledBlobId?: string
}

export interface FoldedToolResultOptions {
  /** 找 tool_call 的范围（入参在 tool_call 上）；缺省只在 removed 里找。传完整时间线可覆盖"调用在前一段、结果在这一段"的切法 */
  lookup?: readonly Event[]
  /** 不列的工具名：脑子自己的工具（整理回执、钉住回执、取回结果）列出来只是噪音 */
  exclude?: ReadonlySet<string>
}

function textChars(content: readonly ContentPart[]): number {
  let n = 0
  for (const p of content) if (p.type === "text") n += p.text.length
  return n
}

/** 从一段被折叠（或被裁掉）的事件里挑出工具结果，按 seq 升序 */
export function foldedToolResults(
  removed: readonly Event[],
  opts: FoldedToolResultOptions = {},
): FoldedToolResult[] {
  const exclude = opts.exclude ?? new Set<string>()
  const calls = new Map<string, CoreEventOf<"core.tool_call">>()
  for (const e of opts.lookup ?? removed) {
    if (e.type === "core.tool_call") {
      const c = e as CoreEventOf<"core.tool_call">
      calls.set(c.payload.toolCallId, c)
    }
  }
  const out: FoldedToolResult[] = []
  for (const e of removed) {
    if (e.type !== "core.tool_result") continue
    const r = e as CoreEventOf<"core.tool_result">
    if (exclude.has(r.payload.name)) continue
    const item: FoldedToolResult = {
      seq: r.seq,
      name: r.payload.name,
      args: calls.get(r.payload.toolCallId)?.payload.args,
      chars: textChars(r.payload.content),
      isError: r.payload.isError,
    }
    if (r.payload.spilled) item.spilledBlobId = r.payload.spilled.blobId
    out.push(item)
  }
  return out.sort((a, b) => a.seq - b.seq)
}

export interface RenderManifestOptions {
  /** 清单标题行；调用方在这里说明怎么取回（core 不知道取回工具叫什么） */
  heading: string
  /** 最多列几条，其余折成一行"…and N more (seq a–b)"。缺省 80：一条约 25 token，上限约 2k token */
  maxItems?: number
  /** 入参 JSON 最多显示多少字符。缺省 100 */
  maxArgsChars?: number
}

/** 入参的短摘要：键排序后的 JSON，超长截断。模型靠它认出"是哪一次调用" */
export function digestArgs(args: unknown, max = 100): string {
  if (args === undefined) return ""
  let text: string
  try {
    text =
      JSON.stringify(args, (_k, v) =>
        typeof v === "object" && v !== null && !Array.isArray(v)
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : v,
      ) ?? String(args)
  } catch {
    text = String(args)
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function fmtChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k chars` : `${n} chars`
}

/** 渲染成给模型看的清单；没有条目返回空字符串 */
export function renderFoldedToolResults(
  items: readonly FoldedToolResult[],
  opts: RenderManifestOptions,
): string {
  if (items.length === 0) return ""
  const maxItems = opts.maxItems ?? 80
  const lines = [opts.heading]
  const shown = items.slice(0, maxItems)
  for (const it of shown) {
    const tail = it.spilledBlobId
      ? `stored as blob "${it.spilledBlobId}", read with fetch_blob`
      : `${fmtChars(it.chars)}${it.isError ? ", error" : ""}`
    lines.push(`- seq ${it.seq} ${it.name}(${digestArgs(it.args, opts.maxArgsChars)}) — ${tail}`)
  }
  if (items.length > shown.length) {
    const rest = items.slice(shown.length)
    lines.push(`- …and ${rest.length} more (seq ${rest[0]?.seq}–${rest[rest.length - 1]?.seq})`)
  }
  return lines.join("\n")
}
