import type { Stores } from "@reins/core"
import { PgBlobStore } from "./blob-store.js"
import type { PgClient } from "./client.js"
import { PgEventLog } from "./event-log.js"
import { PgMemoryStore } from "./memory-store.js"
import { migratePg } from "./schema.js"

export interface PgStoresOptions {
  /** 起步时建表（幂等）。缺省 true；自己管迁移的宿主传 false */
  migrate?: boolean
  /** 测试注入时间 */
  now?: () => number
}

/**
 * 一套 Postgres 存储：`createAgent({ store: await pgStores(pool) })`。
 * client 是任何有 `query(text, params) → { rows }` 的对象：pg 的 Pool / Client、PGlite 实例。
 */
export async function pgStores(client: PgClient, opts: PgStoresOptions = {}): Promise<Stores> {
  if (opts.migrate !== false) await migratePg(client)
  return {
    log: new PgEventLog(client),
    blobs: new PgBlobStore(client, opts.now),
    memory: new PgMemoryStore(client, opts.now),
  }
}
