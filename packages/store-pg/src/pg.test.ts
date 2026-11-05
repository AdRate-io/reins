import { PGlite } from "@electric-sql/pglite"
import { type Event, InMemoryEventLog, type Stores } from "@reinsjs/core"
import {
  blobStoreConformance,
  collect,
  eventLogConformance,
  makeEvents,
  memoryStoreConformance,
  runLeaseConformance,
} from "@reinsjs/core/testing"
import { drizzle } from "drizzle-orm/postgres-js"
import pg from "pg"
import postgres from "postgres"
import postgresV4 from "postgres-v4"
import { afterAll, describe, expect, it } from "vitest"
import {
  isUniqueViolation,
  migratePg,
  PG_SCHEMA_SQL,
  PG_SCHEMA_STATEMENTS,
  type PgClient,
  PgEventLog,
  PgMemoryStore,
  PgRunLease,
  pgStores,
  postgresJsClient,
} from "./index.js"

/**
 * backend 矩阵。每一列跑同一组一致性套件与特有行为；`kind` 决定哪些用例能在它上面断言。
 *
 * - **PGlite 直连**（`direct`，缺省就有）：WASM Postgres，真引擎、不需要服务器。单会话串行，撞不出主键冲突，并发用例跳过。
 * - **真库**（`real`，设了 REINS_PG_URL 才有）：pg、postgres.js 3 / 4、以及被 Drizzle `drizzle(sql)` 改写过
 *   parser / serializer 的 postgres.js 3 / 4，共五列。postgres.js 只会说线协议，参数类型推断与序列化在协议层（踩坑 47），
 *   只能对真服务端测。CI 起 `postgres:16.13-alpine` 服务容器（与 AdRate 生产同版本）并设 REINS_PG_URL；
 *   CI 里没设就直接失败，不许静默跳过。本地没设时只跑 PGlite 直连并提示一次，dogfood 与发版前必须在真库上绿过。
 *
 * 曾用 pglite-socket 让 postgres.js 在进程内连 PGlite，它多连接会交错、SQL 报错后会返回空结果（踩坑 48），已移除。
 */
type BackendKind = "direct" | "real"
const pglite = new PGlite()
const backends: { name: string; kind: BackendKind; client: PgClient; close: () => Promise<void> }[] = [
  { name: "PGlite", kind: "direct", client: pglite, close: () => pglite.close() },
]

const realUrl = process.env.REINS_PG_URL
if (!realUrl && process.env.CI) {
  throw new Error("CI 必须设 REINS_PG_URL：pg / postgres.js / Drizzle 的真库列不能在 CI 里静默跳过")
}
if (realUrl) {
  const pgjs = { max: 4, onnotice: () => {} }
  const pool = new pg.Pool({ connectionString: realUrl })
  const real3 = postgres(realUrl, pgjs)
  const real4 = postgresV4(realUrl, pgjs)
  // Drizzle 会就地改写实例的 options.parsers / serializers（日期类、json / jsonb 换成透传），所以单开实例，不与上面两列共用
  const drizzled3 = postgres(realUrl, pgjs)
  const drizzled4 = postgresV4(realUrl, pgjs)
  drizzle(drizzled3)
  drizzle(drizzled4 as unknown as postgres.Sql) // drizzle-orm 的类型绑在 postgres 3 上；运行时只读写 options
  const real = (name: string, client: PgClient, close: () => Promise<void>) =>
    backends.push({ name: `${name}（${realUrl}）`, kind: "real", client, close })
  real("pg", pool, () => pool.end())
  real("postgres.js 3", postgresJsClient(real3), () => real3.end())
  real("postgres.js 4", postgresJsClient(real4), () => real4.end())
  real("postgres.js 3 + Drizzle", postgresJsClient(drizzled3), () => drizzled3.end())
  real("postgres.js 4 + Drizzle", postgresJsClient(drizzled4), () => drizzled4.end())
} else {
  console.warn("[store-pg] 没设 REINS_PG_URL：只跑 PGlite 直连，pg / postgres.js / Drizzle 的真库列跳过")
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

      it("驱动把主键冲突放在 err.code = 23505，isUniqueViolation 认得出", async () => {
        await fresh()
        const insert = () =>
          backend.client.query("INSERT INTO reins_runs (session_id, owner, expires_at) VALUES ($1, $2, $3)", [
            "dup",
            "A",
            1,
          ])
        await insert()
        const err = await insert().then(
          () => null,
          (e: unknown) => e,
        )
        expect(isUniqueViolation(err)).toBe(true)
      })

      it.skipIf(backend.kind !== "real")(
        "并发 append 同一 seq：两个写入者都过了 WHERE 守卫时撞主键，23505 翻成 seq_conflict，日志只留一份",
        async () => {
          // 串行的 PGlite 永远走不到这条路径（后到者在 WHERE 守卫处就插 0 行），只有真库并发才撞得出；多跑几轮保证至少撞到一次
          await fresh()
          let viaUniqueViolation = 0
          for (let round = 0; round < 20; round++) {
            const sessionId = `race-${round}`
            const [a, b] = [new PgEventLog(backend.client), new PgEventLog(backend.client)]
            const results = await Promise.allSettled([
              a.append(makeEvents(sessionId, 1)),
              b.append(makeEvents(sessionId, 1)),
            ])
            expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
            const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult
            expect(failure.reason).toMatchObject({ code: "seq_conflict" })
            if (String(failure.reason.message).includes("another writer")) viaUniqueViolation++
            expect((await collect(a.read(sessionId))).map((e) => e.seq)).toEqual([1])
          }
          expect(viaUniqueViolation).toBeGreaterThan(0)
        },
      )

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

      it("事件按文本过库：库内是 json 对象、文本逐字等于 JSON.stringify（append 与 fork 都是）", async () => {
        // 只比"读回一致"不够：旧行兼容会把二次编码的字符串标量也解回原事件，必须直接看库里存的是什么（踩坑 47）
        const stores = await fresh()
        const [first] = makeEvents("s1", 1)
        const tricky = {
          ...first,
          payload: {
            content: [{ type: "text", text: '中文 😀 "q" \\ \n\t end' }],
            zLast: 1,
            aFirst: { y: 2, b: [1, [2, { k: [] }], null] },
            big: 9_007_199_254_740_991,
            neg: -5e-8,
          },
        } as unknown as Event
        const events = [tricky, ...makeEvents("s1", 2, 2)]
        await stores.log.append(events)
        await stores.log.fork("s1", 2, "s2")
        const rows = await backend.client.query(
          "SELECT json_typeof(data) AS t, data::text AS txt FROM reins_events ORDER BY session_id, seq",
        )
        const expected = [...events, ...events.slice(0, 2).map((e) => ({ ...e, sessionId: "s2" }))]
        expect(rows.rows.map((r) => r.t)).toEqual(expected.map(() => "object"))
        expect(rows.rows.map((r) => r.txt)).toEqual(expected.map((e) => JSON.stringify(e)))
        expect((await collect(stores.log.read("s1"))).map((e) => JSON.stringify(e))).toEqual(
          events.map((e) => JSON.stringify(e)),
        )
        expect(JSON.stringify(await stores.log.tail("s2", 2))).toBe(JSON.stringify(expected.slice(3)))
      })

      it("旧行兼容：库里是 JSON 字符串标量（早先裸包 postgres.js 写下的二次编码）也读回原事件，之后的新写入是对象", async () => {
        const stores = await fresh()
        const [old] = makeEvents("s1", 1)
        await backend.client.query(
          "INSERT INTO reins_events (session_id, seq, id, type, at, data) VALUES ($1, $2, $3, $4, $5, to_json($6::text))",
          ["s1", 1, old?.id, old?.type, old?.at, JSON.stringify(old)],
        )
        await stores.log.append(makeEvents("s1", 1, 2))
        const kinds = await backend.client.query(
          "SELECT json_typeof(data) AS t FROM reins_events WHERE session_id = $1 ORDER BY seq",
          ["s1"],
        )
        expect(kinds.rows.map((r) => r.t)).toEqual(["string", "object"])
        const back = await collect(stores.log.read("s1"))
        expect(back[0]).toEqual(old)
        expect(back.map((e) => e.seq)).toEqual([1, 2])
        expect(await stores.log.tail("s1", 2)).toEqual(back)
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
        const exists = await backend.client.query(
          "SELECT to_regclass('reins_events') IS NOT NULL AS events, to_regclass('reins_memory') IS NOT NULL AS memory",
        )
        expect(exists.rows[0]).toEqual({ events: false, memory: false })
        // 缺表时写入要把驱动的 SQL 错误原样抛上来（顺带证明适配器不吞错）
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
