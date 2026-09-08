import type { Stores } from "@reins/core"
import { SqliteBlobStore } from "./blob-store.js"
import type { SqliteDatabase } from "./driver.js"
import { SqliteEventLog } from "./event-log.js"
import { SqliteMemoryStore } from "./memory-store.js"
import { migrateSqlite } from "./schema.js"

export interface SqliteStoresOptions {
  /** 起步时建表（幂等）。缺省 true；自己管迁移的宿主传 false */
  migrate?: boolean
  /** 测试注入时间 */
  now?: () => number
}

/**
 * 一套 SQLite 存储：`createAgent({ store: sqliteStores(db) })`。
 * db 是 node:sqlite 的 DatabaseSync 或 bun:sqlite 的 Database（Node 下可用 `@reins/store-sqlite/node` 的 openSqlite 打开）。
 */
export function sqliteStores(db: SqliteDatabase, opts: SqliteStoresOptions = {}): Stores {
  if (opts.migrate !== false) migrateSqlite(db)
  return {
    log: new SqliteEventLog(db),
    blobs: new SqliteBlobStore(db, opts.now),
    memory: new SqliteMemoryStore(db, opts.now),
  }
}
