/**
 * 三张表。事件整条存 JSON（`data`），几列壳字段抽出来做主键与查询：
 * - 主键 (session_id, seq)：seq 连续由 append 校验，唯一约束是并发写入者的最后一道闸
 * - 不加 STRICT，兼容更老的 SQLite 版本；类型由本包写入端保证
 */
export const SQLITE_SCHEMA_SQL = `
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
CREATE TABLE IF NOT EXISTS reins_memory (
  path       TEXT    PRIMARY KEY,
  content    TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
`

/** 建表（幂等）。sqliteStores() 缺省会调；自己管迁移的宿主也可以直接执行 SQLITE_SCHEMA_SQL */
export function migrateSqlite(db: { exec(sql: string): void }): void {
  db.exec(SQLITE_SCHEMA_SQL)
}
