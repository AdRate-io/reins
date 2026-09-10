import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { InMemoryEventLog, type StoreError } from "@reins/core"
import {
  blobStoreConformance,
  collect,
  eventLogConformance,
  makeEvents,
  memoryStoreConformance,
} from "@reins/core/testing"
import { afterAll, describe, expect, it } from "vitest"
import {
  DEFAULT_MEMORY_TABLE,
  migrateSqlite,
  SQLITE_SCHEMA_SQL,
  SqliteEventLog,
  SqliteMemoryStore,
  sqliteStores,
} from "./index.js"
import { openSqlite } from "./node.js"

const memoryDb = () => new DatabaseSync(":memory:")

// ---- 三份一致性套件：每个用例一个全新的内存库 ----
eventLogConformance({ describe, it }, () => sqliteStores(memoryDb()).log)
blobStoreConformance(
  { describe, it },
  () => sqliteStores(memoryDb()).blobs as NonNullable<ReturnType<typeof sqliteStores>["blobs"]>,
)
memoryStoreConformance(
  { describe, it },
  () => sqliteStores(memoryDb()).memory as NonNullable<ReturnType<typeof sqliteStores>["memory"]>,
)

describe("@reins/store-sqlite：SQLite 特有行为", () => {
  const dir = mkdtempSync(join(tmpdir(), "reins-sqlite-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("文件库：关掉再打开，数据还在；openSqlite 缺省开 WAL", async () => {
    const path = join(dir, "a.db")
    const db = openSqlite(path)
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal")
    const stores = sqliteStores(db)
    await stores.log.append(makeEvents("s1", 3))
    await stores.memory?.write("/memories/a.md", "hello")
    const { id } = await (stores.blobs as NonNullable<typeof stores.blobs>).put("blob", {
      mime: "text/plain",
      sessionId: "s1",
    })
    db.close()

    const again = sqliteStores(openSqlite(path))
    expect((await collect(again.log.read("s1"))).map((e) => e.seq)).toEqual([1, 2, 3])
    expect(await again.memory?.read("/memories/a.md")).toBe("hello")
    expect(new TextDecoder().decode((await again.blobs?.get(id))?.bytes)).toBe("blob")
  })

  it("migrate:false 不建表：没有表时构造期就抛（预编译语句），不等到第一次写；migrateSqlite 幂等", async () => {
    const db = memoryDb()
    expect(() => sqliteStores(db, { migrate: false })).toThrow(/no such table/)
    sqliteStores(db)
    const stores = sqliteStores(db) // 第二次建表不报错
    await stores.log.append(makeEvents("s1", 1))
    expect((await stores.log.tail("s1", 1)).map((e) => e.seq)).toEqual([1])
  })

  it("与内存实现逐字节一致：同一批事件写两边，读出来 deepEqual", async () => {
    const mem = new InMemoryEventLog()
    const sql = new SqliteEventLog(memoryDbWithSchema())
    const events = makeEvents("s1", 5)
    await mem.append(events)
    await sql.append(events)
    expect(await collect(sql.read("s1", { fromSeq: 2, toSeq: 4 }))).toEqual(
      await collect(mem.read("s1", { fromSeq: 2, toSeq: 4 })),
    )
    await mem.fork("s1", 3, "s2")
    await sql.fork("s1", 3, "s2")
    expect(await collect(sql.read("s2"))).toEqual(await collect(mem.read("s2")))
  })

  it("长会话分页读取：超过一页也按 seq 连续读全", async () => {
    const log = sqliteStores(memoryDb()).log
    await log.append(makeEvents("s1", 1203))
    const seqs = (await collect(log.read("s1"))).map((e) => e.seq)
    expect(seqs).toHaveLength(1203)
    expect(seqs[0]).toBe(1)
    expect(seqs.at(-1)).toBe(1203)
    expect((await collect(log.read("s1", { fromSeq: 499, toSeq: 502 }))).map((e) => e.seq)).toEqual([
      499, 500, 501, 502,
    ])
  })

  it("多进程写同一文件：另一个连接抢先写入后，本连接的 append 报 seq_conflict 且不留半批", async () => {
    const path = join(dir, "b.db")
    const a = sqliteStores(openSqlite(path))
    const b = sqliteStores(openSqlite(path))
    await a.log.append(makeEvents("s1", 2))
    await b.log.append(makeEvents("s1", 1, 3)) // b 看到末尾是 2，写 3
    await expect(a.log.append(makeEvents("s1", 2, 3))).rejects.toMatchObject({
      code: "seq_conflict",
    } satisfies Partial<StoreError>)
    expect((await collect(a.log.read("s1"))).map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it("memory list 的前缀含 % 与 _ 也按字面匹配", async () => {
    const store = new SqliteMemoryStore(memoryDbWithSchema())
    await store.write("/memories/a_b.md", "1")
    await store.write("/memories/axb.md", "2")
    await store.write("/memories/100%.md", "3")
    expect(await store.list("/memories/a_")).toEqual(["/memories/a_b.md"])
    expect(await store.list("/memories/100%")).toEqual(["/memories/100%.md"])
  })

  it("memoryTable：同一个库里两套记忆各用一张表，互不可见；事件表与 blob 表共用", async () => {
    const db = memoryDb()
    const finance = sqliteStores(db, { memoryTable: "finance_memory" })
    const legal = sqliteStores(db, { memoryTable: "legal_memory" })
    await finance.memory?.write("/memories/notes.md", "预算 3%")
    await legal.memory?.write("/memories/notes.md", "合同条款")
    expect(await finance.memory?.read("/memories/notes.md")).toBe("预算 3%")
    expect(await legal.memory?.read("/memories/notes.md")).toBe("合同条款")
    expect(await finance.memory?.list("/")).toEqual(["/memories/notes.md"])
    // 缺省表不受影响，且确实建的是指定名字的表
    expect(await sqliteStores(db).memory?.list("/")).toEqual([])
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(tables).toEqual([
      "finance_memory",
      "legal_memory",
      "reins_blobs",
      "reins_events",
      DEFAULT_MEMORY_TABLE,
    ])
    // 事件日志是同一张表：一边写另一边读得到
    await finance.log.append(makeEvents("s1", 2))
    expect((await collect(legal.log.read("s1"))).map((e) => e.seq)).toEqual([1, 2])
  })

  it("memoryTable：非法表名在建表前就拒绝（invalid_argument），不碰数据库；缺省 DDL 文本不变", () => {
    const db = memoryDb()
    for (const bad of ["", "1abc", "a-b", "a.b", 'x"; DROP TABLE reins_events; --', "a".repeat(64)]) {
      expect(() => sqliteStores(db, { memoryTable: bad })).toThrow(
        expect.objectContaining({ code: "invalid_argument" } satisfies Partial<StoreError>),
      )
      expect(() => new SqliteMemoryStore(db, { table: bad })).toThrow(
        expect.objectContaining({ code: "invalid_argument" } satisfies Partial<StoreError>),
      )
    }
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master").get()).toEqual({ n: 0 })
    expect(SQLITE_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS reins_memory (")
    expect(SQLITE_SCHEMA_SQL).not.toContain("${")
    // migrateSqlite 单独调也认表名，且幂等
    migrateSqlite(db, { memoryTable: `m_63_${"x".repeat(58)}` })
    migrateSqlite(db, { memoryTable: `m_63_${"x".repeat(58)}` })
    expect(new SqliteMemoryStore(db, { table: `m_63_${"x".repeat(58)}` })).toBeInstanceOf(SqliteMemoryStore)
  })
})

function memoryDbWithSchema(): DatabaseSync {
  const db = memoryDb()
  sqliteStores(db)
  return db
}
