import type { MemoryStore } from "@reins/core"
import type { PgClient } from "./client.js"

/** Postgres 记忆后端：路径 → 文本。前缀匹配用 left()，不用 LIKE（免转义）；排序用 "C" 排序规则得到与内存实现一致的字节序 */
export class PgMemoryStore implements MemoryStore {
  constructor(
    private readonly client: PgClient,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async list(prefix: string): Promise<string[]> {
    const res = await this.client.query(
      'SELECT path FROM reins_memory WHERE left(path, $2) = $1 ORDER BY path COLLATE "C"',
      [prefix, prefix.length],
    )
    return res.rows.map((r) => r.path as string)
  }

  async read(path: string): Promise<string | null> {
    const res = await this.client.query("SELECT content FROM reins_memory WHERE path = $1", [path])
    const row = res.rows[0]
    return row ? (row.content as string) : null
  }

  async write(path: string, content: string): Promise<void> {
    await this.client.query(
      `INSERT INTO reins_memory (path, content, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (path) DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at`,
      [path, content, this.now()],
    )
  }

  async delete(path: string): Promise<void> {
    await this.client.query("DELETE FROM reins_memory WHERE path = $1", [path])
  }
}
