/**
 * @reinsjs/store-sqlite/node —— 用 Node 22.13+ 内置的 node:sqlite 打开数据库。只有这个子路径出现 `node:*`。
 *
 * 文件库缺省开 WAL 与 5 秒 busy_timeout：多进程（如 server 的多个 worker）写同一个文件时排队而不是立刻报 SQLITE_BUSY。
 * node:sqlite 在 22.x 仍会打一条 ExperimentalWarning，属 Node 行为，本包不吞（宿主可用 --no-warnings）。
 */
import { DatabaseSync } from "node:sqlite"
import type { SqliteDatabase } from "./driver.js"

export interface OpenSqliteOptions {
  /** 文件库缺省 true；":memory:" 不适用 */
  wal?: boolean
  /** 毫秒，缺省 5000 */
  busyTimeoutMs?: number
}

export function openSqlite(path: string, opts: OpenSqliteOptions = {}): SqliteDatabase & DatabaseSync {
  const db = new DatabaseSync(path)
  if (path !== ":memory:") {
    if (opts.wal !== false) db.exec("PRAGMA journal_mode = WAL")
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000))}`)
  }
  db.exec("PRAGMA foreign_keys = ON")
  return db
}
