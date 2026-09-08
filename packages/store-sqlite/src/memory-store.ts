import type { MemoryStore } from "@reins/core"
import type { SqliteDatabase } from "./driver.js"

/** SQLite 记忆后端：路径 → 文本的 KV。前缀匹配用 substr 而不是 LIKE，免得转义 % 与 _ */
export class SqliteMemoryStore implements MemoryStore {
  private readonly stmts

  constructor(
    db: SqliteDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.stmts = {
      list: db.prepare("SELECT path FROM reins_memory WHERE substr(path, 1, ?) = ? ORDER BY path"),
      read: db.prepare("SELECT content FROM reins_memory WHERE path = ?"),
      write: db.prepare(
        "INSERT INTO reins_memory (path, content, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
      ),
      delete: db.prepare("DELETE FROM reins_memory WHERE path = ?"),
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
