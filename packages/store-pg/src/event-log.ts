import { type Event, type EventLog, type ReadOptions, StoreError } from "@reins/core"
import { isUniqueViolation, type PgClient } from "./client.js"

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of iter) out.push(x)
  return out
}

const READ_PAGE = 500

/**
 * Postgres 事件日志。契约与内存实现一致（技术方案 §5）。
 *
 * append 是**一条语句**：`INSERT … SELECT FROM unnest(...) WHERE 当前末尾 = 首条 seq − 1`。
 * 末尾不符（别人已经写了）→ 一行都不插，返回空 → seq_conflict；两个写入者同时通过 WHERE 检查 → 主键冲突（23505）→ seq_conflict。
 * 不开事务、不借连接，传连接池也正确。
 */
export class PgEventLog implements EventLog {
  constructor(private readonly client: PgClient) {}

  async append(events: readonly Event[]): Promise<void> {
    if (events.length === 0) throw new StoreError("empty_batch", "append 的事件数组为空")
    const first = events[0] as Event
    const sessionId = first.sessionId
    let expected = first.seq
    for (const e of events) {
      if (e.sessionId !== sessionId) {
        throw new StoreError("session_mismatch", "同一批 append 必须属于同一个会话", {
          expected: sessionId,
          got: e.sessionId,
        })
      }
      if (e.seq !== expected) {
        throw new StoreError(
          "seq_conflict",
          `会话 ${sessionId} 一批内 seq 不连续：期望 ${expected}，收到 ${e.seq}`,
          {
            sessionId,
            expected,
            got: e.seq,
          },
        )
      }
      expected++
    }
    if (first.seq < 1) {
      throw new StoreError("seq_conflict", `会话 ${sessionId} 的 seq 必须从 1 起，收到 ${first.seq}`, {
        sessionId,
        got: first.seq,
      })
    }

    let inserted: number
    try {
      const res = await this.client.query(
        `INSERT INTO reins_events (session_id, seq, id, type, at, data)
         SELECT $1, u.seq, u.id, u.type, u.at, u.data
         FROM unnest($2::int[], $3::text[], $4::text[], $5::bigint[], $6::json[]) AS u(seq, id, type, at, data)
         WHERE (SELECT COALESCE(MAX(seq), 0) FROM reins_events WHERE session_id = $1) = $7
         RETURNING seq`,
        [
          sessionId,
          events.map((e) => e.seq),
          events.map((e) => e.id),
          events.map((e) => e.type),
          events.map((e) => e.at),
          events.map((e) => JSON.stringify(e)),
          first.seq - 1,
        ],
      )
      inserted = res.rows.length
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new StoreError("seq_conflict", `会话 ${sessionId} 的 seq 已被别的写入者占用`, { sessionId })
      }
      throw err
    }
    if (inserted === 0) {
      const last = await this.lastSeqOf(sessionId)
      throw new StoreError("seq_conflict", `会话 ${sessionId} 期望 seq=${last + 1}，收到 ${first.seq}`, {
        sessionId,
        expected: last + 1,
        got: first.seq,
      })
    }
  }

  private async lastSeqOf(sessionId: string): Promise<number> {
    const res = await this.client.query(
      "SELECT COALESCE(MAX(seq), 0)::int AS last FROM reins_events WHERE session_id = $1",
      [sessionId],
    )
    return Number(res.rows[0]?.last ?? 0)
  }

  async *read(sessionId: string, opts: ReadOptions = {}): AsyncIterable<Event> {
    let from = Math.max(opts.fromSeq ?? 1, 1)
    const to = opts.toSeq ?? 2_147_483_647
    while (from <= to) {
      const res = await this.client.query(
        "SELECT data FROM reins_events WHERE session_id = $1 AND seq >= $2 AND seq <= $3 ORDER BY seq LIMIT $4",
        [sessionId, from, to, READ_PAGE],
      )
      for (const row of res.rows) yield eventOf(row.data)
      if (res.rows.length < READ_PAGE) return
      from += res.rows.length
    }
  }

  async tail(sessionId: string, n: number): Promise<Event[]> {
    if (!Number.isInteger(n) || n < 0)
      throw new StoreError("invalid_argument", `tail 的 n 必须是非负整数：${n}`)
    if (n === 0) return []
    const res = await this.client.query(
      "SELECT data FROM reins_events WHERE session_id = $1 ORDER BY seq DESC LIMIT $2",
      [sessionId, n],
    )
    return res.rows.reverse().map((r) => eventOf(r.data))
  }

  async fork(fromSessionId: string, atSeq: number, toSessionId: string): Promise<void> {
    const lastSeq = await this.lastSeqOf(fromSessionId)
    if (!Number.isInteger(atSeq) || atSeq < 1 || atSeq > lastSeq) {
      throw new StoreError(
        "out_of_range",
        `fork 点 ${atSeq} 超出会话 ${fromSessionId} 的范围 [1, ${lastSeq}]`,
        {
          fromSessionId,
          atSeq,
          lastSeq,
        },
      )
    }
    if ((await this.lastSeqOf(toSessionId)) > 0) {
      throw new StoreError("target_not_empty", `目标会话 ${toSessionId} 已有事件`, { toSessionId })
    }
    // 读出 → 改 sessionId → 整批插回。json 列没有 jsonb_set 可用，而改成 jsonb 会重排键序（见 schema.ts），
    // 所以在 JS 里改；插回用与 append 相同的"目标末尾必须为 0"守卫 + 主键约束，检查与插入之间有人写了目标会话也不会交错
    const source = (await collect(this.read(fromSessionId, { toSeq: atSeq }))).map((e) => ({
      ...e,
      sessionId: toSessionId,
    }))
    let inserted: number
    try {
      const res = await this.client.query(
        `INSERT INTO reins_events (session_id, seq, id, type, at, data)
         SELECT $1, u.seq, u.id, u.type, u.at, u.data
         FROM unnest($2::int[], $3::text[], $4::text[], $5::bigint[], $6::json[]) AS u(seq, id, type, at, data)
         WHERE NOT EXISTS (SELECT 1 FROM reins_events WHERE session_id = $1)
         RETURNING seq`,
        [
          toSessionId,
          source.map((e) => e.seq),
          source.map((e) => e.id),
          source.map((e) => e.type),
          source.map((e) => e.at),
          source.map((e) => JSON.stringify(e)),
        ],
      )
      inserted = res.rows.length
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new StoreError("target_not_empty", `目标会话 ${toSessionId} 已有事件`, { toSessionId })
      }
      throw err
    }
    if (inserted === 0)
      throw new StoreError("target_not_empty", `目标会话 ${toSessionId} 已有事件`, { toSessionId })
  }
}

/** json 列：pg 与 PGlite 都已解析成对象（文本原样 → 键序不变）；万一驱动给的是字符串也兼容 */
function eventOf(data: unknown): Event {
  return (typeof data === "string" ? JSON.parse(data) : data) as Event
}
