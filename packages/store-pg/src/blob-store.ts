import { type BlobMeta, type BlobStore, StoreError, uuidv7 } from "@reinsjs/core"
import type { PgClient } from "./client.js"

interface MetaRow {
  session_id: string
  mime: string
  size: number | string
  created_at: number | string
}

/** Postgres 大对象存储：bytea 列；`slice` 用 substring 在库内切 */
export class PgBlobStore implements BlobStore {
  constructor(
    private readonly client: PgClient,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async put(bytes: Uint8Array | string, meta: { mime: string; sessionId: string }): Promise<{ id: string }> {
    const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
    const id = uuidv7()
    await this.client.query(
      "INSERT INTO reins_blobs (id, session_id, mime, size, created_at, bytes) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, meta.sessionId, meta.mime, data.byteLength, this.now(), data],
    )
    return { id }
  }

  async get(id: string): Promise<{ bytes: Uint8Array; meta: BlobMeta }> {
    const res = await this.client.query(
      "SELECT session_id, mime, size, created_at, bytes FROM reins_blobs WHERE id = $1",
      [id],
    )
    const row = res.rows[0] as (MetaRow & { bytes: Uint8Array }) | undefined
    if (!row) throw new StoreError("not_found", `blob not found: ${id}`, { id })
    return { bytes: new Uint8Array(row.bytes), meta: metaOf(row) }
  }

  async slice(id: string, range: { start: number; end: number }): Promise<Uint8Array> {
    const start = Math.max(0, Math.floor(range.start))
    const length = Math.max(0, Math.floor(range.end) - start)
    const res = await this.client.query(
      "SELECT substring(bytes FROM $2 FOR $3) AS part FROM reins_blobs WHERE id = $1",
      [id, start + 1, length],
    )
    const row = res.rows[0] as { part: Uint8Array | null } | undefined
    if (!row) throw new StoreError("not_found", `blob not found: ${id}`, { id })
    return row.part ? new Uint8Array(row.part) : new Uint8Array(0)
  }
}

/** pg 把 bigint 当字符串返回，integer 是数字；统一成 number */
function metaOf(row: MetaRow): BlobMeta {
  return {
    mime: row.mime,
    sessionId: row.session_id,
    size: Number(row.size),
    createdAt: Number(row.created_at),
  }
}
