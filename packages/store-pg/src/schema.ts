import { StoreError } from "@reinsjs/core"
import type { PgClient } from "./client.js"

/** 记忆表缺省名。事件表与 blob 表不可配：它们由 EventLog / BlobStore 的契约唯一确定，隔离靠 session_id */
export const DEFAULT_MEMORY_TABLE = "reins_memory"

/**
 * 表名只认 `字母 / 下划线开头 + 字母数字下划线`，长度 ≤ 63（Postgres 标识符上限，超长会被静默截断成别的名字）。
 * 表名会被字面拼进 SQL（参数绑定不了标识符），这个白名单就是防注入的唯一一道闸；不合规直接抛，不碰数据库。
 * 不加引号：未加引号的标识符 Postgres 统一折成小写，DDL 与查询走同一条折叠规则，两边一致。
 */
export function assertTableName(name: string, what = "memoryTable"): string {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) {
    throw new StoreError(
      "invalid_argument",
      `${what} is not a valid table name (^[A-Za-z_][A-Za-z0-9_]{0,62}$)`,
      {
        [what]: name,
      },
    )
  }
  return name
}

export interface PgSchemaOptions {
  /** 记忆表名。缺省 `reins_memory`；多套记忆共用一个库时按表隔离（技术方案 §9.6 隔离第一层） */
  memoryTable?: string
}

/**
 * 四张表。事件整条存 `json`（`data`），壳字段抽几列做主键与查询；主键 (session_id, seq) 的唯一约束是并发写入者的最后一道闸。
 * `at` / `created_at` / `updated_at` 是 Unix 毫秒（bigint），读事件时不用它们 —— 事件从 data 整条还原。
 * `reins_runs` 是 run 租约表（D4）：每条会话最多一行，`expires_at` 是**数据库时钟**的 Unix 毫秒——过期判定在 SQL 里比 `now()`，
 * 不用各实例本机时钟。
 *
 * **为什么是 json 不是 jsonb**：jsonb 会重排对象键序，读回来 `JSON.stringify` 就变了；而 T10 的 pendingDigest / configHash
 * 正是按 JSON.stringify 算的，存 Postgres 的会话一续跑就会误报"pending 被篡改"。json 按文本原样存取，各后端逐字节一致。
 */
export function pgSchemaStatements(opts: PgSchemaOptions = {}): readonly string[] {
  const memoryTable = assertTableName(opts.memoryTable ?? DEFAULT_MEMORY_TABLE)
  return [
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
    `CREATE TABLE IF NOT EXISTS ${memoryTable} (
  path       text    PRIMARY KEY,
  content    text    NOT NULL,
  updated_at bigint  NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS reins_runs (
  session_id text    PRIMARY KEY,
  owner      text    NOT NULL,
  expires_at bigint  NOT NULL
)`,
  ]
}

/** 缺省表名的逐条 DDL */
export const PG_SCHEMA_STATEMENTS: readonly string[] = pgSchemaStatements()

/** 缺省表名的整段 DDL（给 psql / 迁移工具用） */
export const PG_SCHEMA_SQL = `${PG_SCHEMA_STATEMENTS.join(";\n")};\n`

/**
 * 建表（幂等）。pgStores() 缺省会调；自己管迁移的宿主可直接执行 PG_SCHEMA_SQL / pgSchemaStatements(opts)。
 * 逐条执行：走扩展协议的客户端（PGlite、pg 的带参查询）不接受一次多条语句。
 */
export async function migratePg(client: PgClient, opts: PgSchemaOptions = {}): Promise<void> {
  for (const statement of pgSchemaStatements(opts)) await client.query(statement)
}
