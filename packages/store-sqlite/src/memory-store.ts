import type { MemoryStore } from "@reins/core"
import type { SqliteDatabase } from "./driver.js"
import { assertTableName, DEFAULT_MEMORY_TABLE } from "./schema.js"

export interface SqliteMemoryStoreOptions {
  /** 表名。缺省 `reins_memory`；表必须已存在（构造期就预编译语句，没有表立刻抛） */
  table?: string
  /** 测试注入时间 */
  now?: () => number
}

/** SQLite 记忆后端：路径 → 文本的 KV。前缀匹配用 substr 而不是 LIKE，免得转义 % 与 _ */
export class SqliteMemoryStore implements MemoryStore {
  private readonly stmts
  private readonly now: () => number

  constructor(db: SqliteDatabase, opts: SqliteMemoryStoreOptions = {}) {
    // 表名字面拼进 SQL，先过白名单（schema.ts 同一条规则）
    const table = assertTableName(opts.table ?? DEFAULT_MEMORY_TABLE, "table")
    this.now = opts.now ?? (() => Date.now())
    this.stmts = {
      list: db.prepare(`SELECT path FROM ${table} WHERE substr(path, 1, ?) = ? ORDER BY path`),
      read: db.prepare(`SELECT content FROM ${table} WHERE path = ?`),
      write: db.prepare(
        `INSERT INTO ${table} (path, content, updated_at) VALUES (?, ?, ?) ` +
          "ON CONFLICT(path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
      ),
      delete: db.prepare(`DELETE FROM ${table} WHERE path = ?`),
    }
  }

  async list(prefix: string): Promise<string[]> {
    const rows = this.stmts.list.all(prefix.length, prefix) as { path: string }[]
    return rows.map((r) => r.path)
  }

  async read(path: string): Promise<string | null> {
    const row = this.stmts.read.get(path) as { content: string } | undefined
    return row ? row.content : null
  }

  async write(path: string, content: string): Promise<void> {
    this.stmts.write.run(path, content, this.now())
  }

  async delete(path: string): Promise<void> {
    this.stmts.delete.run(path)
  }
}
