/**
 * 图片引用形态（2026-11-24 媒体引用方案，AdRate 建议 17 第二步）：字节放 BlobStore，日志只存 `{ type: "image", mime, blobId }`。
 *
 * 两件事，都在本文件一份（真源索引）：
 * 1. **写入校验**（`checkImageRefs`）：循环的三个写入口（起步 input、中途 pullInput、工具结果）与 server 的 HTTP 预校验共用。
 *    fail-closed，越权当不存在：不存在、不归本会话、mime 不符、没配 BlobStore 一律同一句 `Blob <id> not found in this session`，
 *    且**先判归属、后比 mime**——不给客户端探测别的租户 blob 是否存在、是什么 mime 的机会。
 *    存储自己抛错（非 not_found）不算"不合规"，原样抛给调用方按各入口的既有口径处理。
 * 2. **换回**（`hydrateImageRefs`）：循环在调降级层之前把本轮视野内的引用换成内联，降级层合同不动；
 *    被折叠的图一个字节都不读。只有 not_found 留着引用（降级层落占位、记 lossy），其它存储错误抛出走模型调用失败的判定——
 *    瞬时故障不能让模型对着占位作答、再把回答永久写进日志。
 *
 * 两件事的读取都走同一个并发池（`readBlobs`，2026-11-24 AdRate 建议 18）：去重、在途 ≤ 16、等全部落定，
 * 再按片段 / 视野原顺序判定——结局与串行逐个读完全一致，只是对象存储上 N 张图从 N 次往返变成一波。
 * `get` / `stat` 返回的不是对象一律当 not_found（防探测，见 `readOne`）。
 *
 * 归属口径（`blobUsableBy`）：blob 的 meta.sessionId 就是本会话，或本会话时间线里已被**图片引用**过
 * （fork 出的会话凭此用父会话的图；recall 取回的结果里是引用，自然合规）。图片引用集合（`mediaRefsOf`）与
 * brain `fetch_blob` 的外溢引用集合刻意分开：只被图片引用过的 blob 不能被 fetch_blob 读出字节，外溢 blob 也当不了图片。
 */
import type { ContentPart, Event, ImageRefPart } from "../events/base.js"
import type { CoreEventOf } from "../events/core.js"
import { StoreError } from "../store/errors.js"
import type { BlobMeta, BlobStore } from "../store/types.js"

/** 图片引用的 blobId 最长字符数 */
export const IMAGE_REF_ID_MAX = 128

/**
 * 图片引用形态的形状判定（真源）：type 为 image、mime 以 "image/" 开头、blobId 非空且 ≤ 128 字符、不带 `data`。
 * `isContentPart` 对引用形态调它；降级层据它区分"未换回的引用"与内联图片
 */
export function isImageRef(p: unknown): p is ImageRefPart {
  if (typeof p !== "object" || p === null) return false
  const r = p as Record<string, unknown>
  return (
    r.type === "image" &&
    typeof r.mime === "string" &&
    r.mime.startsWith("image/") &&
    typeof r.blobId === "string" &&
    r.blobId.length > 0 &&
    r.blobId.length <= IMAGE_REF_ID_MAX &&
    r.data === undefined
  )
}

/** 一批片段里的图片引用 */
function imageRefsIn(parts: readonly ContentPart[]): ImageRefPart[] {
  return parts.filter(isImageRef)
}

/** 带内容片段的两种事件（图片引用只会出现在这里） */
function contentOf(e: Event): readonly ContentPart[] | undefined {
  if (e.type === "core.user_message") return (e as CoreEventOf<"core.user_message">).payload.content
  if (e.type === "core.tool_result") return (e as CoreEventOf<"core.tool_result">).payload.content
  return undefined
}

/**
 * 本会话时间线里被图片引用过的 blob id 集合：只看 user_message / tool_result 的 content 里的图片引用，
 * 不看 `spilled`、不看文本、不看 ext.*。与 fetch_blob 的"外溢引用集合"刻意分开（见文件头）
 */
export function mediaRefsOf(timeline: readonly Event[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const e of timeline) {
    const parts = contentOf(e)
    if (!Array.isArray(parts)) continue
    for (const p of imageRefsIn(parts)) ids.add(p.blobId)
  }
  return ids
}

/**
 * 一个 blob 能不能被这个会话当图片用：`meta.sessionId === sessionId`，或已在 `mediaRefsOf(timeline)` 里。
 * 循环写入校验、server 预校验、宿主自建的下发路由共用这一份——下发路由只比 meta.sessionId 的话，fork 会话显示不了父会话的图。
 * 常见情况（本会话自己的 blob）不扫时间线
 */
export function blobUsableBy(
  sessionId: string,
  meta: BlobMeta,
  id: string,
  timeline: readonly Event[],
): boolean {
  return meta.sessionId === sessionId || mediaRefsOf(timeline).has(id)
}

/** 写入校验不过时的唯一一句话：不存在、越权、mime 不符、没配 BlobStore 都是它 */
export function imageRefNotFound(id: string): string {
  return `Blob ${id} not found in this session`
}

/**
 * run 级缓存：blobId → 字节（base64）与 blob 自己的 meta。写入校验与换回取到的都放进去，同一 blob 一个 run 只读一次；
 * 失败结果不进缓存。带 meta 是为了命中时照样判归属、比 mime——只按 blobId 放行的话，同一 blob 换个 mime 就能写进日志
 * （厂商收到标错类型的字节、之后每轮 400），日志里混进的引用也会被当成已校验（2026-11-24 独立审查）
 */
export type ImageRefCache = Map<string, { data: string; meta: BlobMeta }>

export interface CheckImageRefsContext {
  sessionId: string
  blobs?: BlobStore | undefined
  /** 本会话时间线（归属判定"已引用过"那一支用；只在 blob 不归本会话时才扫） */
  timeline: readonly Event[]
  cache: ImageRefCache
  /**
   * 只判归属与 mime、不留字节：存储有 `stat` 用 `stat`，否则退回 `get`；读到的不放进 cache。
   * server 的 HTTP 预校验用（那份缓存用完即弃）；循环内不传——写进日志前的最终裁决与发给厂商的字节出自同一次 `get`
   */
  metaOnly?: boolean
}

/**
 * 校验一批片段里的图片引用。全部合规返回 undefined；任一不合规返回统一的那一句（`imageRefNotFound`）。
 * 未缓存的 blob 先去重、并发读完，再**按片段顺序**逐个判、报第一个问题（与读取完成先后无关）；
 * 取到的字节放进 cache（`metaOnly` 时不放；缓存命中不再读存储，但归属与 mime 照判）。
 * 存储抛的非 not_found 错误原样抛出（按片段顺序第一个），调用方按各自入口的口径处理
 */
export async function checkImageRefs(
  parts: readonly ContentPart[],
  ctx: CheckImageRefsContext,
): Promise<string | undefined> {
  const reads = await prefetchImageRefs(parts, ctx)
  for (const ref of imageRefsIn(parts)) {
    const problem = judgeImageRef(ref, ctx, reads)
    if (problem !== undefined) return problem
  }
  return undefined
}

/** 一次并发读取的落定表：blobId → 读到的元信息（与字节）或失败原因 */
export type ImageRefReads = ReadonlyMap<string, BlobRead>

/**
 * 写入校验第一步（循环内部用，不进公开导出）：本批片段里未缓存的引用去重后并发读完。
 * 非 `metaOnly` 时读到的一律放进 cache（含第一个问题之后的——缓存命中照判归属与 mime，放进去无害）
 */
export async function prefetchImageRefs(
  parts: readonly ContentPart[],
  ctx: CheckImageRefsContext,
): Promise<ImageRefReads> {
  if (ctx.blobs === undefined) return new Map()
  const ids = imageRefsIn(parts)
    .map((r) => r.blobId)
    .filter((id) => !ctx.cache.has(id))
  if (ids.length === 0) return new Map()
  const metaOnly = ctx.metaOnly === true
  const reads = await readBlobs(ctx.blobs, ids, metaOnly)
  if (!metaOnly) {
    for (const [id, r] of reads) {
      if (r.ok && r.data !== undefined) ctx.cache.set(id, { data: r.data, meta: r.meta })
    }
  }
  return reads
}

/**
 * 写入校验第二步（循环内部用，不进公开导出）：按落定表判一个引用。合规返回 undefined，不合规返回统一那句，
 * 读取时存储抛的非 not_found 错误原样抛出。只消费落定表与缓存，不再为同一 id 二次读取
 */
export function judgeImageRef(
  ref: ImageRefPart,
  ctx: CheckImageRefsContext,
  reads: ImageRefReads,
): string | undefined {
  if (ctx.blobs === undefined) return imageRefNotFound(ref.blobId)
  let meta: BlobMeta
  const cached = ctx.cache.get(ref.blobId)
  if (cached !== undefined) meta = cached.meta
  else {
    const read = reads.get(ref.blobId)
    if (read === undefined) throw new Error(`internal: blob ${ref.blobId} was not prefetched`)
    if (!read.ok) {
      if (isNotFound(read.error)) return imageRefNotFound(ref.blobId)
      throw read.error
    }
    meta = read.meta
  }
  // 先归属、后 mime：顺序反过来，别的租户就能用 mime 探出 blob 存在
  if (!blobUsableBy(ctx.sessionId, meta, ref.blobId, ctx.timeline)) return imageRefNotFound(ref.blobId)
  if (meta.mime !== ref.mime) return imageRefNotFound(ref.blobId)
  return undefined
}

export interface HydrateImageRefsContext {
  blobs?: BlobStore | undefined
  cache: ImageRefCache
}

/**
 * 视图里的图片引用换回内联（只碰 user_message / tool_result 的 content，其它事件原样返回同一对象）。
 * - 缓存里有的直接用；视野内未缓存的去重后并发 `get`（上限见 `BLOB_READ_CONCURRENCY`），读完按原顺序换回
 * - `StoreError("not_found")` 与没配 BlobStore：片段保持引用形态交给降级层（落 `[image unavailable]` 占位、记 lossy），不进缓存
 * - 其它存储错误：读成功的先进缓存（重试只重读失败的），再按视野顺序抛第一个——循环把它当模型调用失败处理（走重试判定），
 *   不让模型对着占位作答
 *
 * 换回后的事件只交给 `toRequest`，不回写日志、不回写 `ctx.events`（Socket 与估算看到的仍是引用）。
 * 直接调 `toRequest` 的宿主（审计回放、探针）先过一遍它，降级层才看得到图
 */
export async function hydrateImageRefs(
  events: readonly Event[],
  ctx: HydrateImageRefsContext,
): Promise<Event[]> {
  let reads: ImageRefReads = new Map()
  if (ctx.blobs !== undefined) {
    const ids: string[] = []
    for (const e of events) {
      const parts = contentOf(e)
      if (!Array.isArray(parts)) continue
      for (const p of imageRefsIn(parts)) if (!ctx.cache.has(p.blobId)) ids.push(p.blobId)
    }
    if (ids.length > 0) reads = await readBlobs(ctx.blobs, ids, false)
    for (const [id, r] of reads) {
      if (r.ok && r.data !== undefined) ctx.cache.set(id, { data: r.data, meta: r.meta })
    }
  }
  const out: Event[] = []
  for (const e of events) {
    const parts = contentOf(e)
    if (!Array.isArray(parts) || !parts.some(isImageRef)) {
      out.push(e)
      continue
    }
    const next: ContentPart[] = []
    for (const p of parts) {
      if (!isImageRef(p)) {
        next.push(p)
        continue
      }
      const data = hydratedData(p.blobId, ctx.cache, reads)
      next.push(data === undefined ? p : { type: "image", mime: p.mime, data })
    }
    out.push({ ...e, payload: { ...(e.payload as object), content: next } })
  }
  return out
}

/** 换回取一张图的 base64：缓存优先；not_found / 没配存储（落定表里没有）返回 undefined，其它错误抛出 */
function hydratedData(id: string, cache: ImageRefCache, reads: ImageRefReads): string | undefined {
  const cached = cache.get(id)
  if (cached !== undefined) return cached.data
  const read = reads.get(id)
  if (read === undefined || read.ok || isNotFound(read.error)) return undefined
  throw read.error
}

// ---- 并发读取（写入校验与换回共用，真源索引） ----

/**
 * 一次调用里同时在途的读取上限。固定、不开配置：AdRate 一条消息最多 10 张，16 一波读完还有余量；
 * 同时防止长会话视野里几十张图一次全打出去。超过后端能力的部分由后端排队；要更低上限的宿主在自己的 BlobStore 里限流
 */
export const BLOB_READ_CONCURRENCY = 16

/** 一个 blob 的落定结果；`data`（字节的 base64）只在不是 metaOnly 时有 */
export type BlobRead = { ok: true; meta: BlobMeta; data?: string } | { ok: false; error: unknown }

/**
 * 并发读一批 blob（内部用，不进公开导出）：去重、池（读完一个立刻补下一个，在途 ≤ `BLOB_READ_CONCURRENCY`）、
 * 等全部落定（失败不打断其它读取）。`metaOnly` 时存储有 `stat` 用 `stat`、否则 `get` 且丢掉字节
 */
export async function readBlobs(
  blobs: BlobStore,
  ids: Iterable<string>,
  metaOnly: boolean,
): Promise<Map<string, BlobRead>> {
  const queue = [...new Set(ids)]
  const out = new Map<string, BlobRead>()
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < queue.length) {
      const id = queue[next++] as string
      try {
        out.set(id, { ok: true, ...(await readOne(blobs, id, metaOnly)) })
      } catch (error) {
        out.set(id, { ok: false, error })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BLOB_READ_CONCURRENCY, queue.length) }, worker))
  return out
}

/**
 * 读一个 blob。按方法调用（SQLite / PG 实现靠 `this`）；async 包着，宿主同步抛错也只是一个落定的失败；
 * base64 也在这里编，字节形状不对（编码抛错）同样落成这一个 blob 的失败，不冲出池子。
 * 返回值不是对象（宿主照 R2 `head()` 写成返回 null）一律当 not_found——否则读 `meta.sessionId` 抛 TypeError 被当存储故障，
 * HTTP 对"存在但不归我"回 400、对"不存在"回 503，客户端就能分辨别的会话的 blob 是否存在（fail-closed）
 */
async function readOne(
  blobs: BlobStore,
  id: string,
  metaOnly: boolean,
): Promise<{ meta: BlobMeta; data?: string }> {
  // 类型上不会是 null，但宿主实现不一定守类型：运行时照查
  if (metaOnly && blobs.stat !== undefined) {
    const meta = await blobs.stat(id)
    if (!isObject(meta)) throw blobNotFound(id)
    return { meta }
  }
  const got = await blobs.get(id)
  if (!isObject(got) || !isObject(got.meta)) throw blobNotFound(id)
  return metaOnly ? { meta: got.meta } : { meta: got.meta, data: bytesToBase64(got.bytes) }
}

function isObject(x: unknown): x is object {
  return typeof x === "object" && x !== null
}

function blobNotFound(id: string): StoreError {
  return new StoreError("not_found", `blob not found: ${id}`, { id })
}

function isNotFound(err: unknown): boolean {
  return err instanceof StoreError && err.code === "not_found"
}

/** 一次交给 String.fromCharCode 的字节数：参数个数有上限（各引擎约 6.5 万～50 万），取 32KB 留足余量 */
const BASE64_CHUNK = 0x8000

/** 零 Node 的 base64 编码：分块拼二进制串再 btoa（Web 标准，workerd / Bun / Deno / Edge 都有） */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK))
  }
  return btoa(binary)
}
