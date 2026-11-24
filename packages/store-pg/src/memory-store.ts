import type { MemoryStore } from "@reinsjs/core"
import type { PgClient } from "./client.js"
import { assertTableName, DEFAULT_MEMORY_TABLE } from "./schema.js"

export interface PgMemoryStoreOptions {
  /** 表名。缺省 `reins_memory` */
  table?: string
  /** 测试注入时间 */
  now?: () => number
}

/** Postgres 记忆后端：路径 → 文本。前缀匹配用 left()，不用 LIKE（免转义）；排序用 "C" 排序规则得到与内存实现一致的字节序 */
export class PgMemoryStore implements MemoryStore {
  private readonly table: string
  private readonly now: () => number

  constructor(
    private readonly client: PgClient,
    opts: PgMemoryStoreOptions = {},
  ) {
    // 表名字面拼进 SQL，先过白名单（schema.ts 同一条规则）
    this.table = assertTableName(opts.table ?? DEFAULT_MEMORY_TABLE, "table")
    this.now = opts.now ?? (() => Date.now())
  }

  async list(prefix: string): Promise<string[]> {
    const res = await this.client.query(
      `SELECT path FROM ${this.table} WHERE left(path, $2) = $1 ORDER BY path COLLATE "C"`,
      // left() 按字符（码点）截，JS 的 length 是 UTF-16 码元数，非 BMP 字符差一；按码点数绑
      [prefix, codePointLength(prefix)],
    )
    return res.rows.map((r) => r.path as string)
  }

  async read(path: string): Promise<string | null> {
    const res = await this.client.query(`SELECT content FROM ${this.table} WHERE path = $1`, [path])
    const row = res.rows[0]
    return row ? (row.content as string) : null
  }

  async write(path: string, content: string): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.table} (path, content, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (path) DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at`,
      [path, content, this.now()],
    )
  }

  async delete(path: string): Promise<void> {
    await this.client.query(`DELETE FROM ${this.table} WHERE path = $1`, [path])
  }
}

/** 码点数：与 PG left() / SQLite substr() 的"字符"同一口径 */
function codePointLength(s: string): number {
  let n = 0
  for (const _ of s) n++
  return n
}
