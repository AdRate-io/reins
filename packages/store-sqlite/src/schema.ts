import { StoreError } from "@reinsjs/core"

/** 记忆表缺省名。事件表与 blob 表不可配：它们由 EventLog / BlobStore 的契约唯一确定，隔离靠 session_id */
export const DEFAULT_MEMORY_TABLE = "reins_memory"

/**
 * 表名只认 `字母 / 下划线开头 + 字母数字下划线`，长度 ≤ 63（与 Postgres 的标识符上限对齐，两包同一规则）。
 * 表名会被字面拼进 SQL（SQL 参数绑定不了标识符），这个白名单就是防注入的唯一一道闸；不合规直接抛，不碰数据库。
 */
export function assertTableName(name: string, what = "memoryTable"): string {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) {
    throw new StoreError("invalid_argument", `${what} 不是合法表名（^[A-Za-z_][A-Za-z0-9_]{0,62}$）`, {
      [what]: name,
    })
  }
  return name
}

export interface SqliteSchemaOptions {
  /** 记忆表名。缺省 `reins_memory`；多套记忆共用一个库时按表隔离（技术方案 §9.6 隔离第一层） */
  memoryTable?: string
}

/**
 * 三张表。事件整条存 JSON（`data`），几列壳字段抽出来做主键与查询：
 * - 主键 (session_id, seq)：seq 连续由 append 校验，唯一约束是并发写入者的最后一道闸
 * - 不加 STRICT，兼容更老的 SQLite 版本；类型由本包写入端保证
 */
export function sqliteSchemaSql(opts: SqliteSchemaOptions = {}): string {
  const memoryTable = assertTableName(opts.memoryTable ?? DEFAULT_MEMORY_TABLE)
  return `
CREATE TABLE IF NOT EXISTS reins_events (
  session_id TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  id         TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  at         INTEGER NOT NULL,
  data       TEXT    NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS reins_blobs (
  id         TEXT    PRIMARY KEY,
  session_id TEXT    NOT NULL,
  mime       TEXT    NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  bytes      BLOB    NOT NULL
);
CREATE TABLE IF NOT EXISTS ${memoryTable} (
  path       TEXT    PRIMARY KEY,
  content    TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
`
}

/** 缺省表名的整段 DDL（给自己管迁移的宿主直接执行） */
export const SQLITE_SCHEMA_SQL = sqliteSchemaSql()

/** 建表（幂等）。sqliteStores() 缺省会调；自己管迁移的宿主也可以直接执行 SQLITE_SCHEMA_SQL / sqliteSchemaSql(opts) */
export function migrateSqlite(db: { exec(sql: string): void }, opts: SqliteSchemaOptions = {}): void {
  db.exec(sqliteSchemaSql(opts))
}
