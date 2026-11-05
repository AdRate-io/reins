/**
 * Postgres 客户端的最小形状：`query(text, params) → { rows }`。
 * `pg` 的 Pool / Client、`@electric-sql/pglite` 的 PGlite 都直接满足；postgres.js 用 `postgresJsClient(sql)`（postgres-js.ts）。
 * 自己包别的驱动时，本包的 SQL 只按文本过库（见 event-log.ts），驱动只需把参数原样绑定、把结果按列名原样交回。
 *
 * 本包**不依赖事务**：每个写操作都是单条语句（append 用 unnest 一次插入整批、fork 用 INSERT … SELECT），
 * 单条语句在 Postgres 里天然原子，所以传连接池进来也是对的 —— 不必为了 BEGIN/COMMIT 从池里借同一条连接。
 */
export interface PgQueryResult {
  rows: Record<string, unknown>[]
}

export interface PgClient {
  query(text: string, params?: readonly unknown[]): Promise<PgQueryResult>
}

/** Postgres 的唯一约束冲突（SQLSTATE 23505）；pg、PGlite、postgres.js 都把它放在 err.code */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505"
}
