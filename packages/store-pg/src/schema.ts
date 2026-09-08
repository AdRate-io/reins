import type { PgClient } from "./client.js"

/**
 * 三张表。事件整条存 `json`（`data`），壳字段抽几列做主键与查询；主键 (session_id, seq) 的唯一约束是并发写入者的最后一道闸。
 * `at` / `created_at` / `updated_at` 是 Unix 毫秒（bigint），读事件时不用它们 —— 事件从 data 整条还原。
 *
 * **为什么是 json 不是 jsonb**：jsonb 会重排对象键序，读回来 `JSON.stringify` 就变了；而 T10 的 pendingDigest / configHash
 * 正是按 JSON.stringify 算的，存 Postgres 的会话一续跑就会误报"pending 被篡改"。json 按文本原样存取，各后端逐字节一致。
 */
export const PG_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS reins_events (
  session_id text    NOT NULL,
  seq        integer NOT NULL,
  id         text    NOT NULL,
  type       text    NOT NULL,
  at         bigint  NOT NULL,
  data       json    NOT NULL,
  PRIMARY KEY (session_id, seq)
)`,
  `CREATE TABLE IF NOT EXISTS reins_blobs (
  id         text    PRIMARY KEY,
  session_id text    NOT NULL,
  mime       text    NOT NULL,
  size       integer NOT NULL,
  created_at bigint  NOT NULL,
  bytes      bytea   NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS reins_memory (
  path       text    PRIMARY KEY,
  content    text    NOT NULL,
  updated_at bigint  NOT NULL
)`,
]

/** 整段 DDL（给 psql / 迁移工具用） */
export const PG_SCHEMA_SQL = `${PG_SCHEMA_STATEMENTS.join(";\n")};\n`

/**
 * 建表（幂等）。pgStores() 缺省会调；自己管迁移的宿主可直接执行 PG_SCHEMA_SQL。
 * 逐条执行：走扩展协议的客户端（PGlite、pg 的带参查询）不接受一次多条语句。
 */
export async function migratePg(client: PgClient): Promise<void> {
  for (const statement of PG_SCHEMA_STATEMENTS) await client.query(statement)
}
