import { PGlite } from "@electric-sql/pglite"
import { InMemoryEventLog, type Stores } from "@reinsjs/core"
import {
  blobStoreConformance,
  collect,
  eventLogConformance,
  makeEvents,
  memoryStoreConformance,
  runLeaseConformance,
} from "@reinsjs/core/testing"
import pg from "pg"
import { afterAll, describe, expect, it } from "vitest"
import {
  migratePg,
  PG_SCHEMA_SQL,
  PG_SCHEMA_STATEMENTS,
  type PgClient,
  PgEventLog,
  PgMemoryStore,
  PgRunLease,
  pgStores,
} from "./index.js"

/**
 * 缺省用 PGlite（进程内 WASM Postgres，真 Postgres 引擎，不需要服务器）跑一致性套件；
 * 设了 REINS_PG_URL（如 postgres://localhost/reins_test）就再对真库跑一遍，dogfood 前必须在真库上绿过。
 */
const pglite = new PGlite()
const backends: { name: string; client: PgClient; close: () => Promise<void> }[] = [
  { name: "PGlite", client: pglite, close: () => pglite.close() },
]
const realUrl = process.env.REINS_PG_URL
if (realUrl) {
  const pool = new pg.Pool({ connectionString: realUrl })
  backends.push({ name: `pg（${realUrl}）`, client: pool, close: () => pool.end() })
}

afterAll(async () => {
  for (const b of backends) await b.close()
})

for (const backend of backends) {
  /** 每个用例一套干净的表：建表幂等，之后清空 */
  const fresh = async (): Promise<Stores> => {
    const stores = await pgStores(backend.client)
    await backend.client.query("TRUNCATE reins_events, reins_blobs, reins_memory, reins_runs")
    return stores
  }

  describe(`@reinsjs/store-pg on ${backend.name}`, () => {
    eventLogConformance({ describe, it }, async () => (await fresh()).log)
    blobStoreConformance({ describe, it }, async () => (await fresh()).blobs as NonNullable<Stores["blobs"]>)
    memoryStoreConformance(
      { describe, it },
      async () => (await fresh()).memory as NonNullable<Stores["memory"]>,
    )
    runLeaseConformance(
      { describe, it },
      async () => (await fresh()).runLease as NonNullable<Stores["runLease"]>,
    )

    describe("run 租约（D4）：单条语句 + 数据库时钟", () => {
      it("两个实例同时对空会话 acquire：恰好一个成功；失败方 renew 为 false；成功方 release 后失败方可占", async () => {
        await fresh()
        const a = new PgRunLease(backend.client)
        const b = new PgRunLease(backend.client)
        const got = await Promise.all([a.acquire("s1", "A", 60_000), b.acquire("s1", "B", 60_000)])
        expect(got.filter(Boolean)).toHaveLength(1)
        const winner = got[0] ? "A" : "B"
        const loser = winner === "A" ? "B" : "A"
        const rows = await backend.client.query("SELECT owner FROM reins_runs WHERE session_id = $1", ["s1"])
        expect(rows.rows).toEqual([{ owner: winner }])
        expect(await a.renew("s1", loser, 60_000)).toBe(false)
        expect(await a.renew("s1", winner, 60_000)).toBe(true)
        await a.release("s1", loser) // 非持有者删不掉
        expect((await backend.client.query("SELECT count(*)::int AS n FROM reins_runs")).rows[0]).toEqual({
          n: 1,
        })
        await a.release("s1", winner)
        expect(await b.acquire("s1", loser, 60_000)).toBe(true)
      })

      it("过期判定用库时间：过期后接手者 acquire 成功且行被改写为新 owner，原持有者 renew 为 false", async () => {
        await fresh()
        const lease = new PgRunLease(backend.client)
        expect(await lease.acquire("s1", "A", 1)).toBe(true)
        await new Promise((r) => setTimeout(r, 30))
        expect(await lease.acquire("s1", "B", 60_000)).toBe(true)
        const rows = await backend.client.query(
          "SELECT owner, expires_at FROM reins_runs WHERE session_id = $1",
          ["s1"],
        )
        expect(rows.rows[0]?.owner).toBe("B")
        // expires_at 是库时钟的 Unix 毫秒，与本机时钟同量级（差在秒级以内即可，不比精确值）
        expect(Math.abs(Number(rows.rows[0]?.expires_at) - (Date.now() + 60_000))).toBeLessThan(5_000)
        expect(await lease.renew("s1", "A", 60_000)).toBe(false)
        expect(await lease.renew("s1", "B", 60_000)).toBe(true)
      })

      it("pgStores 带 runLease；建表语句含 reins_runs", async () => {
        const stores = await fresh()
        expect(stores.runLease).toBeInstanceOf(PgRunLease)
        expect(PG_SCHEMA_SQL).toContain("reins_runs")
      })
    })

    describe("Postgres 特有行为", () => {
      it("append 是单条语句：两个日志实例共用同一库，后写的一方拿到 seq_conflict，日志不留半批", async () => {
        const stores = await fresh()
        const other = new PgEventLog(backend.client)
        await stores.log.append(makeEvents("s1", 2))
        await other.append(makeEvents("s1", 1, 3))
        await expect(stores.log.append(makeEvents("s1", 2, 3))).rejects.toMatchObject({
          code: "seq_conflict",
        })
        expect((await collect(stores.log.read("s1"))).map((e) => e.seq)).toEqual([1, 2, 3])
      })

      it("与内存实现读出来 deepEqual（json 列往返不改内容，本包刻意不用 jsonb）；fork 后 sessionId 换掉、其余原样", async () => {
        const stores = await fresh()
        const mem = new InMemoryEventLog()
        const events = makeEvents("s1", 5)
        await mem.append(events)
        await stores.log.append(events)
        expect(await collect(stores.log.read("s1", { fromSeq: 2, toSeq: 4 }))).toEqual(
          await collect(mem.read("s1", { fromSeq: 2, toSeq: 4 })),
        )
        await mem.fork("s1", 3, "s2")
        await stores.log.fork("s1", 3, "s2")
        expect(await collect(stores.log.read("s2"))).toEqual(await collect(mem.read("s2")))
      })

      it("长会话分页读取：超过一页也按 seq 连续读全", async () => {
        const stores = await fresh()
        await stores.log.append(makeEvents("s1", 1203))
        const seqs = (await collect(stores.log.read("s1"))).map((e) => e.seq)
        expect(seqs).toHaveLength(1203)
        expect(seqs[0]).toBe(1)
        expect(seqs.at(-1)).toBe(1203)
        expect(
          (await collect(stores.log.read("s1", { fromSeq: 499, toSeq: 502 }))).map((e) => e.seq),
        ).toEqual([499, 500, 501, 502])
      })

      it("migrate:false 不建表；migratePg 幂等", async () => {
        await fresh()
        await backend.client.query("DROP TABLE reins_events, reins_blobs, reins_memory")
        const stores = await pgStores(backend.client, { migrate: false })
        await expect(stores.log.append(makeEvents("s1", 1))).rejects.toThrow(/reins_events/)
        await pgStores(backend.client)
        await pgStores(backend.client)
        await stores.log.append(makeEvents("s1", 1))
        expect((await stores.log.tail("s1", 1)).map((e) => e.seq)).toEqual([1])
      })

      it("memory list 的前缀含 % 与 _ 也按字面匹配", async () => {
        const stores = await fresh()
        const store = stores.memory as NonNullable<Stores["memory"]>
        await store.write("/memories/a_b.md", "1")
        await store.write("/memories/axb.md", "2")
        await store.write("/memories/100%.md", "3")
        expect(await store.list("/memories/a_")).toEqual(["/memories/a_b.md"])
        expect(await store.list("/memories/100%")).toEqual(["/memories/100%.md"])
      })

      it("memoryTable：同一个库里两套记忆各用一张表，互不可见；事件表共用", async () => {
        await fresh()
        await backend.client.query("DROP TABLE IF EXISTS finance_memory, legal_memory")
        const finance = await pgStores(backend.client, { memoryTable: "finance_memory" })
        const legal = await pgStores(backend.client, { memoryTable: "legal_memory" })
        await finance.memory?.write("/memories/notes.md", "预算 3%")
        await legal.memory?.write("/memories/notes.md", "合同条款")
        expect(await finance.memory?.read("/memories/notes.md")).toBe("预算 3%")
        expect(await legal.memory?.read("/memories/notes.md")).toBe("合同条款")
        expect(await finance.memory?.list("/")).toEqual(["/memories/notes.md"])
        expect(await (await pgStores(backend.client)).memory?.list("/")).toEqual([])
        const tables = await backend.client.query(
          "SELECT table_name FROM information_schema.tables WHERE table_name IN ($1, $2) ORDER BY table_name",
          ["finance_memory", "legal_memory"],
        )
        expect(tables.rows.map((r) => r.table_name)).toEqual(["finance_memory", "legal_memory"])
        await finance.log.append(makeEvents("s1", 2))
        expect((await collect(legal.log.read("s1"))).map((e) => e.seq)).toEqual([1, 2])
      })

      it("memoryTable：非法表名在建表前就拒绝（invalid_argument），不发任何语句；缺省 DDL 文本不变", async () => {
        const sent: string[] = []
        const spy: PgClient = {
          query: async (text, params) => {
            sent.push(text)
            return backend.client.query(text, params)
          },
        }
        for (const bad of ["", "1abc", "a-b", "a.b", 'x"; DROP TABLE reins_events; --', "a".repeat(64)]) {
          await expect(pgStores(spy, { memoryTable: bad })).rejects.toMatchObject({
            code: "invalid_argument",
          })
          expect(() => new PgMemoryStore(spy, { table: bad })).toThrow(
            expect.objectContaining({ code: "invalid_argument" }),
          )
        }
        expect(sent).toEqual([])
        expect(PG_SCHEMA_STATEMENTS[2]).toContain("CREATE TABLE IF NOT EXISTS reins_memory (")
        expect(PG_SCHEMA_SQL).not.toContain("${")
        const long = `m_63_${"x".repeat(58)}`
        await migratePg(backend.client, { memoryTable: long })
        await migratePg(backend.client, { memoryTable: long }) // 幂等
        const store = new PgMemoryStore(backend.client, { table: long })
        await store.write("/memories/a.md", "1")
        expect(await store.read("/memories/a.md")).toBe("1")
        await backend.client.query(`DROP TABLE ${long}`)
      })
    })
  })
}
