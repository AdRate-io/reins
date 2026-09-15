import { type Event, type EventLog, type ReadOptions, StoreError } from "@reinsjs/core"
import { isUniqueViolation, type SqliteDatabase, transaction } from "./driver.js"

/** 每次分页读取的条数：既不把整条长会话一次拉进内存，也不至于一条一查 */
const READ_PAGE = 500

interface Row {
  data: string
}

/**
 * SQLite 事件日志。契约与内存实现一致（技术方案 §5）：
 * append 先整批校验（同会话、从末尾 +1 连续）再在一个事务里写入；读出的事件由 JSON 重新解析，天然是副本。
 */
export class SqliteEventLog implements EventLog {
  private readonly stmts

  constructor(private readonly db: SqliteDatabase) {
    this.stmts = {
      lastSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) AS last FROM reins_events WHERE session_id = ?"),
      insert: db.prepare(
        "INSERT INTO reins_events (session_id, seq, id, type, at, data) VALUES (?, ?, ?, ?, ?, ?)",
      ),
      page: db.prepare(
        "SELECT data FROM reins_events WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq LIMIT ?",
      ),
      tail: db.prepare("SELECT data FROM reins_events WHERE session_id = ? ORDER BY seq DESC LIMIT ?"),
      // fork：原样复制壳字段，只把 JSON 里的 sessionId 换掉
      fork: db.prepare(
        "INSERT INTO reins_events (session_id, seq, id, type, at, data) " +
          "SELECT ?, seq, id, type, at, json_set(data, '$.sessionId', ?) FROM reins_events " +
          "WHERE session_id = ? AND seq <= ? ORDER BY seq",
      ),
    }
  }

  private lastSeqOf(sessionId: string): number {
    const row = this.stmts.lastSeq.get(sessionId) as { last: number | bigint }
    return Number(row.last)
  }

  async append(events: readonly Event[]): Promise<void> {
    if (events.length === 0) throw new StoreError("empty_batch", "append received an empty event array")
    const sessionId = (events[0] as Event).sessionId
    for (const e of events) {
      if (e.sessionId !== sessionId) {
        throw new StoreError("session_mismatch", "all events in one append must belong to the same session", {
          expected: sessionId,
          got: e.sessionId,
        })
      }
    }
    try {
      transaction(this.db, () => {
        let expected = this.lastSeqOf(sessionId) + 1
        for (const e of events) {
          if (e.seq !== expected) {
            throw new StoreError(
              "seq_conflict",
              `session ${sessionId} expected seq=${expected}, got ${e.seq}`,
              {
                sessionId,
                expected,
                got: e.seq,
              },
            )
          }
          expected++
        }
        for (const e of events) this.stmts.insert.run(sessionId, e.seq, e.id, e.type, e.at, JSON.stringify(e))
      })
    } catch (err) {
      // BEGIN IMMEDIATE 下同进程不会撞到，这里兜的是多进程写同一个文件
      if (isUniqueViolation(err)) {
        throw new StoreError("seq_conflict", `session ${sessionId}: seq already taken by another writer`, {
          sessionId,
        })
      }
      throw err
    }
  }

  async *read(sessionId: string, opts: ReadOptions = {}): AsyncIterable<Event> {
    let from = Math.max(opts.fromSeq ?? 1, 1)
    const to = opts.toSeq ?? Number.MAX_SAFE_INTEGER
    while (from <= to) {
      const rows = this.stmts.page.all(sessionId, from, to, READ_PAGE) as Row[]
      for (const row of rows) yield JSON.parse(row.data) as Event
      if (rows.length < READ_PAGE) return
      from += rows.length
    }
  }

  async tail(sessionId: string, n: number): Promise<Event[]> {
    if (!Number.isInteger(n) || n < 0)
      throw new StoreError("invalid_argument", `tail: n must be a non-negative integer, got ${n}`)
    if (n === 0) return []
    const rows = this.stmts.tail.all(sessionId, n) as Row[]
    return rows.reverse().map((r) => JSON.parse(r.data) as Event)
  }

  async fork(fromSessionId: string, atSeq: number, toSessionId: string): Promise<void> {
    transaction(this.db, () => {
      const lastSeq = this.lastSeqOf(fromSessionId)
      if (!Number.isInteger(atSeq) || atSeq < 1 || atSeq > lastSeq) {
        throw new StoreError(
          "out_of_range",
          `fork point ${atSeq} is outside session ${fromSessionId}'s range [1, ${lastSeq}]`,
          {
            fromSessionId,
            atSeq,
            lastSeq,
          },
        )
      }
      if (this.lastSeqOf(toSessionId) > 0) {
        throw new StoreError("target_not_empty", `target session ${toSessionId} already has events`, {
          toSessionId,
        })
      }
      this.stmts.fork.run(toSessionId, toSessionId, fromSessionId, atSeq)
    })
  }
}
