import type { Stores } from "@reinsjs/core"
import { PgBlobStore } from "./blob-store.js"
import type { PgClient } from "./client.js"
import { PgEventLog } from "./event-log.js"
import { PgMemoryStore, type PgMemoryStoreOptions } from "./memory-store.js"
import { migratePg, type PgSchemaOptions } from "./schema.js"

export interface PgStoresOptions {
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
 * 一套 Postgres 存储：`createAgent({ store: await pgStores(pool) })`。
 * client 是任何有 `query(text, params) → { rows }` 的对象：pg 的 Pool / Client、PGlite 实例。
 */
export async function pgStores(client: PgClient, opts: PgStoresOptions = {}): Promise<Stores> {
  const schema: PgSchemaOptions = {}
  const memoryOpts: PgMemoryStoreOptions = {}
  if (opts.memoryTable !== undefined) {
    schema.memoryTable = opts.memoryTable
    memoryOpts.table = opts.memoryTable
  }
  if (opts.now !== undefined) memoryOpts.now = opts.now
  if (opts.migrate !== false) await migratePg(client, schema)
  return {
    log: new PgEventLog(client),
    blobs: new PgBlobStore(client, opts.now),
    memory: new PgMemoryStore(client, memoryOpts),
  }
}
