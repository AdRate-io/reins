/**
 * spill —— 结果外溢模块（技术方案 §9.4，B4）。
 *
 * 工具偶尔会吐回一大坨（整页搜索结果、几千行日志、一个大 JSON）。硬塞进上下文既贵又挤掉别的东西，
 * 直接截断又等于替模型决定"后面的不重要"。本模块的做法：
 *
 * 1. **afterTool 外溢**：结果的文本部分超过 `maxResultTokens`（缺省 8k，工具可用 `resultPolicy.maxTokens` 单独配）
 *    → 全文原样写进 BlobStore，模型看到的结果换成 `[说明 + 首尾各 N 行预览]`，并在 `tool_result.spilled` 记下
 *    `{ blobId, summary }`。全文一个字都没丢，只是搬到了旁边；决定读不读、读哪段的仍是模型（宪法一）。
 *    工具声明 `resultPolicy.overflow = "truncate"` 时不存 blob、只留预览并明说中段不可恢复 —— 这是宿主对该工具的显式选择。
 *    没有 BlobStore 则外溢自动关闭（结果原样通过）并告警一次；声明了 truncate 的工具照常截断（截断不需要存储）。
 * 2. **工具 `fetch_blob({ id, start?, end? })`**：按字符偏移分段取回，每次最多给 `maxResultTokens` 那么多，
 *    头部说明总长与下一段从哪开始。只能读本会话的 blob（越权当不存在），只读文本类 mime。
 *    它的结果本身不再外溢（已经按上限裁过），否则会自己咬自己。
 *
 * 为什么在 afterTool 而不是包装工具的 execute：宿主的工具不必知道 reins 的存在（P3），也让 MCP / OpenAPI 来源的工具
 * 同样受益；afterTool 拿到的是尚未 append 的草稿，返回即替换，日志里只有一条 tool_result（T9 决策）。
 * `spilled` 字段是给 UI / 回放 / 感知看的（perception 统计"可见外溢结果数"就靠它），降级层不翻译它。
 *
 * 图片片段不度量也不外溢（一张图对模型是固定开销，没有"分页读"的意义），原样保留在预览之后。
 */
import {
  type BlobStore,
  type ContentPart,
  type Socket,
  StoreError,
  type Tool,
  type ToolCallEvent,
  type ToolContext,
  type ToolResultDraft,
  type TurnContext,
} from "@reins/core"
import {
  clipEndByTokens,
  defaultTextTokens,
  fmt,
  measureText,
  type Preview,
  previewOf,
  type TextTokenEstimator,
} from "./preview.js"
import { FETCH_BLOB_TOOL_DESCRIPTION, FETCH_BLOB_TOOL_NAME, SPILL_RULES } from "./rules.js"

export interface SpillOptions {
  /** 结果文本超过多少 token 就外溢；也是 fetch_blob 单次返回的上限。工具的 `resultPolicy.maxTokens` 优先。缺省 8000 */
  maxResultTokens?: number
  /** 预览首尾各取多少行。缺省 20 */
  previewLines?: number
  /** 预览首尾各最多多少字符（防单行超长）。缺省 min(2000, maxResultTokens / 4)，保证预览本身远低于上限 */
  previewChars?: number
  /** 文本 token 估算器；缺省 core 粗估。宿主有精确 tokenizer 时注入 */
  estimate?: TextTokenEstimator
  /** 是否给模型 fetch_blob 工具。缺省 true；false 时外溢仍发生，只是模型取不回（宿主自己提供读法时用） */
  tool?: boolean
  /** 规则提示：缺省内置英文文案；传字符串替换；false 则不碰系统提示 */
  rules?: string | false
  /** 没有 BlobStore 时的告警出口（每个 spill() 实例只告警一次）。缺省 console.warn */
  warn?: (message: string) => void
}

export const SPILL_SOCKET_NAME = "spill"
export const DEFAULT_MAX_RESULT_TOKENS = 8000
export const DEFAULT_PREVIEW_LINES = 20
export const DEFAULT_PREVIEW_CHARS = 2000
/** 外溢正文的 mime；BlobStore 按 UTF-8 存字符串 */
export const SPILL_BLOB_MIME = "text/plain; charset=utf-8"

export const FETCH_BLOB_INPUT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "The blob id shown in the tool result preview." },
    start: {
      type: "integer",
      minimum: 0,
      description: "0-based character offset to start from. Omit to start at the beginning.",
    },
    end: {
      type: "integer",
      minimum: 1,
      description: "Character offset to stop before (exclusive). Omit to read as much as fits.",
    },
  },
  required: ["id"],
  additionalProperties: false,
} as const

export interface FetchBlobArgs {
  id: string
  start?: number
  end?: number
}

export function parseFetchBlobArgs(raw: unknown): FetchBlobArgs {
  if (typeof raw !== "object" || raw === null)
    throw new RangeError(`${FETCH_BLOB_TOOL_NAME} expects an object`)
  const o = raw as Record<string, unknown>
  if (typeof o.id !== "string" || o.id.trim().length === 0)
    throw new RangeError("`id` must be a non-empty string")
  const out: FetchBlobArgs = { id: o.id.trim() }
  if (o.start !== undefined) {
    if (!Number.isInteger(o.start) || (o.start as number) < 0)
      throw new RangeError("`start` must be an integer ≥ 0")
    out.start = o.start as number
  }
  if (o.end !== undefined) {
    if (!Number.isInteger(o.end) || (o.end as number) < 1)
      throw new RangeError("`end` must be an integer ≥ 1")
    out.end = o.end as number
  }
  if (out.start !== undefined && out.end !== undefined && out.end <= out.start) {
    throw new RangeError("`end` must be greater than `start`")
  }
  return out
}

/** 能当文本给模型看的 mime：text/*、JSON / XML / YAML / JS 及其 +json / +xml 变体 */
export function isTextMime(mime: string): boolean {
  const m = mime.toLowerCase().split(";")[0]?.trim() ?? ""
  if (m.startsWith("text/")) return true
  if (/^application\/(json|xml|yaml|x-yaml|javascript|x-ndjson|ld\+json)$/.test(m)) return true
  return m.endsWith("+json") || m.endsWith("+xml")
}

/** 结果里全部文本片段拼成的正文（片段之间空行分隔），以及非文本片段 */
function splitContent(content: readonly ContentPart[]): { text: string; rest: ContentPart[] } {
  const texts: string[] = []
  const rest: ContentPart[] = []
  for (const p of content) {
    if (p.type === "text") texts.push(p.text)
    else rest.push(p)
  }
  return { text: texts.join("\n\n"), rest }
}

function renderPreview(preview: Preview): string {
  if (preview.tail.length === 0) return preview.head
  // head 按行切时自带末尾换行，按字符裁时没有；统一成"恰好一个换行"再接省略标记
  const head = preview.head.endsWith("\n") ? preview.head : `${preview.head}\n`
  return `${head}[... ${fmt(preview.omitted.chars)} characters (${fmt(preview.omitted.lines)} lines) omitted ...]\n${preview.tail}`
}

type Overflow = "spill" | "truncate"

export function spill(opts: SpillOptions = {}): Socket {
  const maxTokens = opts.maxResultTokens ?? DEFAULT_MAX_RESULT_TOKENS
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new RangeError(`spill.maxResultTokens 必须是 ≥1 的整数：${String(maxTokens)}`)
  }
  const previewLines = opts.previewLines ?? DEFAULT_PREVIEW_LINES
  if (!Number.isInteger(previewLines) || previewLines < 0) {
    throw new RangeError(`spill.previewLines 必须是 ≥0 的整数：${String(previewLines)}`)
  }
  const previewChars = opts.previewChars ?? Math.min(DEFAULT_PREVIEW_CHARS, Math.floor(maxTokens / 4))
  if (!Number.isInteger(previewChars) || previewChars < 0) {
    throw new RangeError(`spill.previewChars 必须是 ≥0 的整数：${String(previewChars)}`)
  }
  const estimate = opts.estimate ?? defaultTextTokens
  const withTool = opts.tool ?? true
  const warn = opts.warn ?? ((message: string) => console.warn(message))
  let warnedNoBlobs = false

  const limitFor = (tool: Tool | undefined): { maxTokens: number; overflow: Overflow } => ({
    maxTokens: tool?.resultPolicy?.maxTokens ?? maxTokens,
    overflow: tool?.resultPolicy?.overflow ?? "spill",
  })

  const fetchBlob: Tool<FetchBlobArgs> = {
    name: FETCH_BLOB_TOOL_NAME,
    description: FETCH_BLOB_TOOL_DESCRIPTION,
    inputSchema: FETCH_BLOB_INPUT_SCHEMA as unknown as Record<string, unknown>,
    validate: parseFetchBlobArgs,
    risk: "low",
    execute: (args, ctx) => readBlobSlice(args, ctx, maxTokens),
  }

  const socket: Socket = {
    name: SPILL_SOCKET_NAME,

    async afterTool(ctx: TurnContext, call: ToolCallEvent, result: ToolResultDraft) {
      const name = call.payload.name
      if (name === FETCH_BLOB_TOOL_NAME) return undefined // 它的输出已按上限裁过，再外溢就自己咬自己
      const policy = limitFor(ctx.tools.find((t) => t.name === name))
      const { text, rest } = splitContent(result.payload.content)
      const measure = measureText(text, estimate)
      if (measure.tokens <= policy.maxTokens) return undefined

      const preview = previewOf(text, { lines: previewLines, chars: previewChars })
      const size = `~${fmt(measure.tokens)} tokens (${fmt(measure.chars)} characters, ${fmt(measure.lines)} lines)`
      const shown =
        preview.tail.length === 0
          ? "The preview below is the beginning of the output."
          : `Below: the first ${previewLines} lines and the last ${previewLines} lines.`

      if (policy.overflow === "truncate") {
        const header = `[Output of \`${name}\` was truncated: ${size} exceeds the inline limit of ${fmt(policy.maxTokens)} tokens, and this tool is configured to truncate rather than store the full output, so the omitted middle cannot be recovered. ${shown}]`
        return replaceContent(result, [
          { type: "text", text: `${header}\n${renderPreview(preview)}` },
          ...rest,
        ])
      }

      if (!ctx.blobs) {
        if (!warnedNoBlobs) {
          warnedNoBlobs = true
          warn(
            `[reins/spill] 没有配置 BlobStore，结果外溢已关闭：\`${name}\` 返回了 ${size}，将原样进入上下文。给 runLoop / createAgent 配上 blobs 即可开启。`,
          )
        }
        return undefined
      }

      const { id } = await ctx.blobs.put(text, { mime: SPILL_BLOB_MIME, sessionId: ctx.session.id })
      const firstSliceEnd = clipEndByTokens(text, policy.maxTokens)
      const header = `[Output of \`${name}\` is too large to show inline: ${size}; the inline limit is ${fmt(policy.maxTokens)} tokens. The complete output is stored verbatim as blob "${id}". Read it with ${FETCH_BLOB_TOOL_NAME}({ id: "${id}", start: 0, end: ${fmt(firstSliceEnd).replace(/,/g, "")} }); offsets are characters, and the header of each fetch tells you where to continue. ${shown}]`
      const summary = `${size} from \`${name}\`, stored as blob ${id}`
      return {
        ...result,
        payload: {
          ...result.payload,
          content: [{ type: "text", text: `${header}\n${renderPreview(preview)}` }, ...rest],
          spilled: { blobId: id, summary },
        },
      }
    },
  }
  if (withTool) socket.tools = [fetchBlob as Tool]
  if (withTool && opts.rules !== false) socket.systemPrompt = opts.rules ?? SPILL_RULES
  return socket
}

function replaceContent(result: ToolResultDraft, content: ContentPart[]): ToolResultDraft {
  return { ...result, payload: { ...result.payload, content } }
}

const fail = (text: string) => ({ content: [{ type: "text", text }] as ContentPart[], isError: true })

/**
 * fetch_blob 的执行：整段取回、按 UTF-8 解码、按字符切片、再按 token 上限裁。
 * 不用 BlobStore.slice：它按字节切，UTF-8 多字节字符会被切坏，而模型说的偏移是字符。
 */
async function readBlobSlice(
  args: FetchBlobArgs,
  ctx: ToolContext,
  maxTokens: number,
): Promise<{ content: ContentPart[]; isError: boolean }> {
  if (!ctx.blobs)
    return fail("No blob store is configured for this session, so stored outputs cannot be read.")
  const blob = await loadOwnBlob(ctx.blobs, args.id, ctx.sessionId)
  if (!blob) return fail(`No blob with id "${args.id}" in this session.`)
  if (!isTextMime(blob.mime)) {
    return fail(
      `Blob "${args.id}" is ${blob.mime} (${fmt(blob.size)} bytes), not text; it cannot be shown inline.`,
    )
  }
  const text = new TextDecoder("utf-8").decode(blob.bytes)
  const total = text.length
  const start = args.start ?? 0
  if (start >= total) {
    return fail(
      `start ${fmt(start)} is at or beyond the end of blob "${args.id}" (${fmt(total)} characters).`,
    )
  }
  const requestedEnd = Math.min(args.end ?? total, total)
  const requested = text.slice(start, requestedEnd)
  const clipAt = clipEndByTokens(requested, maxTokens)
  const clipped = clipAt < requested.length
  const slice = clipped ? requested.slice(0, clipAt) : requested
  const shownEnd = start + slice.length
  const lines = measureText(text).lines
  const next =
    shownEnd < total
      ? `Continue with start: ${fmt(shownEnd).replace(/,/g, "")}.`
      : "This is the end of the output."
  const header = `[blob "${args.id}": characters ${fmt(start)}–${fmt(shownEnd)} of ${fmt(total)} (${fmt(lines)} lines total)${clipped ? `; clipped to fit ${fmt(maxTokens)} tokens` : ""}. ${next}]`
  return { content: [{ type: "text", text: `${header}\n${slice}` }], isError: false }
}

/** 取本会话的 blob；不存在或属于别的会话都返回 undefined（不泄露别的会话有没有这个 id） */
async function loadOwnBlob(
  blobs: BlobStore,
  id: string,
  sessionId: string,
): Promise<{ bytes: Uint8Array; mime: string; size: number } | undefined> {
  try {
    const { bytes, meta } = await blobs.get(id)
    if (meta.sessionId !== sessionId) return undefined
    return { bytes, mime: meta.mime, size: meta.size }
  } catch (err) {
    if (err instanceof StoreError && err.code === "not_found") return undefined
    throw err
  }
}
