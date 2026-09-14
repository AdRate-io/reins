/**
 * @reinsjs/store-pg —— PostgreSQL 后端（技术方案 §5，B9）。dogfood 宿主（投放工具）用的就是它。
 *
 * 只认 `query(text, params) → { rows }` 这一个方法（pg 的 Pool / Client、PGlite 都满足），
 * 所有写操作都是单条语句，不开事务，传连接池也正确。零 `node:*` 依赖。
 */
export * from "./blob-store.js"
export * from "./client.js"
export * from "./event-log.js"
export * from "./memory-store.js"
export * from "./schema.js"
export * from "./stores.js"
