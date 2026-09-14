import type { RunLease } from "@reinsjs/core"
import type { PgClient } from "./client.js"

/** 数据库时钟的 Unix 毫秒。每条语句自己算一次；单条语句内 now() 恒定，比较与写入用的是同一时刻 */
const DB_NOW_MS = "(extract(epoch from now()) * 1000)::bigint"

/**
 * Postgres run 租约（D4）：一张 `reins_runs(session_id PK, owner, expires_at)`，三条都是**单条语句**，不开事务、不借连接，
 * 传连接池也正确（与本包其余部分同一约束）。
 *
 * - acquire：`INSERT … ON CONFLICT DO UPDATE … WHERE 已过期 OR 持有者是自己 RETURNING`。插到 0 行 = 别人持有且未过期。
 *   两个实例同时对空会话 acquire：Postgres 的 ON CONFLICT 保证后到者看到先到者已提交的行再判 WHERE，只有一个拿到。
 * - renew：条件 UPDATE，`owner` 相符且未过期才延长；0 行 = 丢了租约。
 * - release：按 `(session_id, owner)` DELETE，不是自己的删不掉。
 *
 * 为什么不用 advisory lock：会话级锁绑连接，而 `PgClient` 只有 `query(text, params)`、连接池每条语句可能走不同连接，解锁找不到上锁那条；
 * 事务级锁要 BEGIN/COMMIT，违反"每个写是单条语句"。
 * 为什么用库时间：租约的意义是各实例对"谁持有"达成一致，判定时钟必须唯一；本机时钟偏几秒就会出现两个持有者。
 */
export class PgRunLease implements RunLease {
  constructor(private readonly client: PgClient) {}

  async acquire(sessionId: string, owner: string, ttlMs: number): Promise<boolean> {
    const res = await this.client.query(
      `INSERT INTO reins_runs (session_id, owner, expires_at)
       VALUES ($1, $2, ${DB_NOW_MS} + $3::bigint)
       ON CONFLICT (session_id) DO UPDATE
         SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
         WHERE reins_runs.expires_at < ${DB_NOW_MS} OR reins_runs.owner = EXCLUDED.owner
       RETURNING owner`,
      [sessionId, owner, Math.round(ttlMs)],
    )
    return res.rows.length === 1
  }

  async renew(sessionId: string, owner: string, ttlMs: number): Promise<boolean> {
    const res = await this.client.query(
      `UPDATE reins_runs SET expires_at = ${DB_NOW_MS} + $3::bigint
       WHERE session_id = $1 AND owner = $2 AND expires_at >= ${DB_NOW_MS}
       RETURNING owner`,
      [sessionId, owner, Math.round(ttlMs)],
    )
    return res.rows.length === 1
  }

  async release(sessionId: string, owner: string): Promise<void> {
    await this.client.query("DELETE FROM reins_runs WHERE session_id = $1 AND owner = $2", [sessionId, owner])
  }
}
