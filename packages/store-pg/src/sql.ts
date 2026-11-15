/**
 * 包内共享的 SQL 片段与读侧解码（不经 index 导出）。
 */
import { type Event, StoreError } from "@reinsjs/core"

/** 数据库时钟的 Unix 毫秒。每条语句自己算一次；单条语句内 now() 恒定，比较与写入用的是同一时刻 */
export const DB_NOW_MS = "(extract(epoch from now()) * 1000)::bigint"

/**
 * 租约"持有中"的判据（真源索引）：`reins_runs` 行未过期。renew 与 `pgRunStates` 共用；acquire 的抢占条件是它的取反
 * （`expires_at < now`），写法不同、口径由用例锁住
 */
export const HELD_SQL = `expires_at >= ${DB_NOW_MS}`

/**
 * 读侧拿到的是 `data::text`，由本包自己解析——驱动的 json 解析器与宿主 transform 都碰不到事件（踩坑 47）。
 *
 * 解出来还是字符串的，是旧行：早先把 postgres.js 裸包一层接入时，`$6::json[]` 让驱动把已序列化的文本又编码了一次，
 * 库里存成了 JSON 字符串标量。再解一层即得原事件；只读兼容，不回写。
 */
export function eventOf(text: unknown): Event {
  if (typeof text !== "string") {
    throw new StoreError("invalid_argument", `event data must be read back as text, got ${typeof text}`)
  }
  const value: unknown = JSON.parse(text)
  return (typeof value === "string" ? JSON.parse(value) : value) as Event
}
