/**
 * SQLite 驱动的最小形状。`node:sqlite` 的 `DatabaseSync` 与 `bun:sqlite` 的 `Database` 都天然满足：
 * 同步 API，`exec` 跑无参 SQL，`prepare(sql)` 得到能 `run / all / get` 的语句。
 * 本包只依赖这几个方法，SQL 层一份，驱动由运行时决定（技术方案 S3）。
 */
export type SqliteValue = null | number | bigint | string | Uint8Array

export interface SqliteStatement {
  run(...params: SqliteValue[]): unknown
  all(...params: SqliteValue[]): unknown[]
  get(...params: SqliteValue[]): unknown
}

export interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
}

/** 同步事务：抛错即回滚并原样抛出 */
export function transaction<T>(db: SqliteDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE")
  try {
    const out = fn()
    db.exec("COMMIT")
    return out
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}

/** node:sqlite / bun:sqlite 的唯一约束错误：两者都把 SQLite 的 errcode 放在不同字段，只认消息更稳 */
export function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed/i.test(message)
}
