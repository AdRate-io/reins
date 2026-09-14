import { type BlobMeta, type BlobStore, StoreError, uuidv7 } from "@reinsjs/core"
import type { SqliteDatabase } from "./driver.js"

interface MetaRow {
  session_id: string
  mime: string
  size: number | bigint
  created_at: number | bigint
}

/** SQLite 大对象存储：字节进 BLOB 列，`slice` 用 substr 在库内切，不把整个 blob 读出来 */
export class SqliteBlobStore implements BlobStore {
  private readonly stmts

  constructor(
    db: SqliteDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.stmts = {
      insert: db.prepare(
        "INSERT INTO reins_blobs (id, session_id, mime, size, created_at, bytes) VALUES (?, ?, ?, ?, ?, ?)",
      ),
      get: db.prepare("SELECT session_id, mime, size, created_at, bytes FROM reins_blobs WHERE id = ?"),
      // substr 对 BLOB 按字节计，起点从 1 起
      slice: db.prepare("SELECT substr(bytes, ?, ?) AS part FROM reins_blobs WHERE id = ?"),
    }
  }

  async put(bytes: Uint8Array | string, meta: { mime: string; sessionId: string }): Promise<{ id: string }> {
    const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
    const id = uuidv7()
    this.stmts.insert.run(id, meta.sessionId, meta.mime, data.byteLength, this.now(), data)
    return { id }
  }

  async get(id: string): Promise<{ bytes: Uint8Array; meta: BlobMeta }> {
    const row = this.stmts.get.get(id) as (MetaRow & { bytes: Uint8Array }) | undefined
    if (!row) throw new StoreError("not_found", `blob 不存在：${id}`, { id })
    return { bytes: new Uint8Array(row.bytes), meta: metaOf(row) }
  }

  async slice(id: string, range: { start: number; end: number }): Promise<Uint8Array> {
    const start = Math.max(0, Math.floor(range.start))
    const length = Math.max(0, Math.floor(range.end) - start)
    const row = this.stmts.slice.get(start + 1, length, id) as { part: Uint8Array | null } | undefined
    if (!row) throw new StoreError("not_found", `blob 不存在：${id}`, { id })
    return row.part ? new Uint8Array(row.part) : new Uint8Array(0)
  }
}

function metaOf(row: MetaRow): BlobMeta {
  return {
    mime: row.mime,
    sessionId: row.session_id,
    size: Number(row.size),
    createdAt: Number(row.created_at),
  }
}
