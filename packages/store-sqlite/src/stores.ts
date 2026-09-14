import type { Stores } from "@reinsjs/core"
import { SqliteBlobStore } from "./blob-store.js"
import type { SqliteDatabase } from "./driver.js"
import { SqliteEventLog } from "./event-log.js"
import { SqliteMemoryStore, type SqliteMemoryStoreOptions } from "./memory-store.js"
import { migrateSqlite, type SqliteSchemaOptions } from "./schema.js"

export interface SqliteStoresOptions {
  /** 起步时建表（幂等）。缺省 true；自己管迁移的宿主传 false */
  migrate?: boolean
  /**
   * 记忆表名，缺省 `reins_memory`。多个 agent 共用一个库、各自一套记忆时，每个传不同的表名；
   * 事件表与 blob 表始终共用（按 session_id 隔离），建表语句随表名同步。
   */
  memoryTable?: string
  /** 测试注入时间 */
  now?: () => number
}

/**
 * 一套 SQLite 存储：`createAgent({ store: sqliteStores(db) })`。
 * db 是 node:sqlite 的 DatabaseSync 或 bun:sqlite 的 Database（Node 下可用 `@reinsjs/store-sqlite/node` 的 openSqlite 打开）。
 */
export function sqliteStores(db: SqliteDatabase, opts: SqliteStoresOptions = {}): Stores {
  const schema: SqliteSchemaOptions = {}
  const memoryOpts: SqliteMemoryStoreOptions = {}
  if (opts.memoryTable !== undefined) {
    schema.memoryTable = opts.memoryTable
    memoryOpts.table = opts.memoryTable
  }
  if (opts.now !== undefined) memoryOpts.now = opts.now
  if (opts.migrate !== false) migrateSqlite(db, schema)
  return {
    log: new SqliteEventLog(db),
    blobs: new SqliteBlobStore(db, opts.now),
    memory: new SqliteMemoryStore(db, memoryOpts),
  }
}
