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
import { SqliteEventLog, SqliteMemoryStore, sqliteStores } from "./index.js"
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
})

function memoryDbWithSchema(): DatabaseSync {
  const db = memoryDb()
  sqliteStores(db)
  return db
}
