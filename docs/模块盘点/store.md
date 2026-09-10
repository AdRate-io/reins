# 模块盘点：@reins/store-sqlite / @reins/store-pg

> 对应技术方案 §5、任务 B9（S3 为 SQLite 驱动选型 spike）。以代码为准，写于 2026-09-10。

## 1 架构概览

两个**可选**存储包，各自把 `@reins/core` 的三个接口（`EventLog` / `BlobStore` / `MemoryStore`，定义在 `packages/core/src/store/types.ts`）落到一种数据库上，合起来由 `sqliteStores(db, opts)` / `pgStores(client, opts)` 打包成 `Stores`，直接交给 `createAgent({ store })`。

依赖方向是单向的：

```
@reins/core（接口 types.ts + 错误 errors.ts + 一致性套件 core/src/testing/）
        ▲                                  ▲
        │ dependencies: workspace:*        │
@reins/store-sqlite                 @reins/store-pg
   └ /node 子路径 → node:sqlite        └ devDep: pg / @electric-sql/pglite（仅测试）
```

- 两个 store 包**互不依赖**，也不被 core 依赖；core 不知道它们存在。
- 运行时依赖只有 `@reins/core` 一个。数据库驱动**不进 dependencies**：由宿主自己 `new DatabaseSync(...)` / `new Pool(...)` 后把对象传进来，包只认接口形状。
- 零 `node:*` 的硬约束：`@reins/store-sqlite` 主入口与 `@reins/store-pg` 全包都没有 `node:*`；唯一的例外是子路径 `@reins/store-sqlite/node`（`src/node.ts`），它存在的目的就是 import `node:sqlite`。
- **共跑一套一致性测试**：`@reins/core/testing` 导出 `eventLogConformance` / `blobStoreConformance` / `memoryStoreConformance`（文件 `packages/core/src/testing/event-log.ts`、`blob-store.ts`、`memory-store.ts`，公共断言与 `collect` 在 `harness.ts`）。套件只要 `{ describe, it }`，断言自带、不绑 vitest。两包各自把 `sqliteStores(...)` / `pgStores(...)` 的三个成员喂给同一组套件（`sqlite.test.ts` 顶部、`pg.test.ts` 的 `fresh()`），内存实现 `InMemoryEventLog` 是基准，特有行为测试再直接与它 `deepEqual` 对比。

## 2 文件清单

| 路径 | 职责 |
| --- | --- |
| `packages/store-sqlite/src/index.ts` | 桶文件，再导出全部；文件头说明"一份 SQL、驱动由运行时给" |
| `packages/store-sqlite/src/driver.ts` | 驱动最小形状 `SqliteDatabase = { exec, prepare }`、`transaction()` 同步事务、`isUniqueViolation()` |
| `packages/store-sqlite/src/schema.ts` | `sqliteSchemaSql({ memoryTable })` 三张建表语句（`SQLITE_SCHEMA_SQL` 是缺省表名版）+ 幂等 `migrateSqlite(db, opts)`；`assertTableName` 表名白名单、`DEFAULT_MEMORY_TABLE` |
| `packages/store-sqlite/src/event-log.ts` | `SqliteEventLog`：预编译 5 条语句，append / read / tail / fork |
| `packages/store-sqlite/src/blob-store.ts` | `SqliteBlobStore`：BLOB 列存字节，`slice` 用 `substr` 库内切 |
| `packages/store-sqlite/src/memory-store.ts` | `SqliteMemoryStore(db, { table?, now? })`：path→content KV，前缀查询用 `substr`，表名构造期过白名单 |
| `packages/store-sqlite/src/stores.ts` | `sqliteStores(db, { migrate?, memoryTable?, now? })` 组装 `Stores`，缺省建表，`memoryTable` 同时透传给建表与 MemoryStore |
| `packages/store-sqlite/src/node.ts` | `/node` 子路径：`openSqlite(path, opts)` 用 `node:sqlite` 开库，文件库缺省 WAL + busy_timeout |
| `packages/store-pg/src/index.ts` | 桶文件；文件头说明"只认 query，不开事务，连接池友好" |
| `packages/store-pg/src/client.ts` | 客户端最小形状 `PgClient = { query(text, params) → { rows } }`、`isUniqueViolation()`（SQLSTATE 23505） |
| `packages/store-pg/src/schema.ts` | `pgSchemaStatements({ memoryTable })` 逐条 DDL（`PG_SCHEMA_STATEMENTS` / `PG_SCHEMA_SQL` 是缺省表名版）+ 幂等 `migratePg(client, opts)`；`assertTableName`、`DEFAULT_MEMORY_TABLE` |
| `packages/store-pg/src/event-log.ts` | `PgEventLog`：append / fork 各是一条语句，read 分页，tail 倒排 |
| `packages/store-pg/src/blob-store.ts` | `PgBlobStore`：`bytea` 列，`slice` 用 `substring(... FROM ... FOR ...)` |
| `packages/store-pg/src/memory-store.ts` | `PgMemoryStore(client, { table?, now? })`：`left()` 前缀匹配，`ORDER BY path COLLATE "C"`，表名构造期过白名单 |
| `packages/store-pg/src/stores.ts` | `pgStores(client, { migrate?, memoryTable?, now? })` 组装 `Stores`（异步，因为建表要 await） |
| `sqlite.test.ts` / `pg.test.ts` | 各自挂三份一致性套件，再加特有行为：持久化与 WAL、`migrate:false`、与内存实现 deepEqual、千级事件分页、并发写 `seq_conflict`、前缀含 `%` `_` 的字面匹配、`memoryTable` 两表隔离 + 非法表名在建表前拒绝且不发语句；pg 缺省跑 PGlite，设 `REINS_PG_URL` 再对真库跑一遍 |

**三张表与索引。** 两边列名一致，只有类型不同：`reins_events`（`session_id` / `seq` / `id` / `type` / `at` / `data`，主键 `(session_id, seq)`），`reins_blobs`（`id` 主键 / `session_id` / `mime` / `size` / `created_at` / `bytes`），`reins_memory`（`path` 主键 / `content` / `updated_at`）。SQLite 侧 `data` 是 `TEXT`、`bytes` 是 `BLOB`、时间是 `INTEGER`，且**故意不加 `STRICT`**（兼容更老的 SQLite，类型由写入端保证）；Postgres 侧 `data` 是 `json`、`bytes` 是 `bytea`、时间是 `bigint`（Unix 毫秒），`seq` 是 `integer`。**除主键外没有任何 `CREATE INDEX`**：事件查询全部走 `(session_id, seq)` 前缀，blob 与 memory 都按主键点查，`reins_blobs.session_id` 上没有索引（不存在按会话扫 blob 的查询）。事件整条以 JSON 存 `data`，读出来直接反序列化，壳字段只是给主键和排序用——所以 schema 演进由 core 的事件注册表 upcast 负责，表结构不用动。

## 3 核心流程

**append 的 seq 连续性校验（乐观并发 `seq_conflict`）** —— 两边语义相同，实现路子不同。

- SQLite（`SqliteEventLog.append`）：先在 JS 里查全批 `sessionId` 一致，否则 `session_mismatch`；空数组 `empty_batch`。然后进 `transaction()`（`BEGIN IMMEDIATE`，拿写锁）：`SELECT COALESCE(MAX(seq),0) FROM reins_events WHERE session_id = ?` 得末尾，`expected = last + 1`，逐条比对 `e.seq !== expected` 就抛 `seq_conflict`——**整批校验通过后才开始插**，所以"要么全写要么全不写"。事务外再兜一层：主键 `UNIQUE constraint failed` 被 `isUniqueViolation()` 认出来，翻译成 `seq_conflict`（同进程有 `BEGIN IMMEDIATE` 撞不到，这层是给多进程写同一个文件的）。
- Postgres（`PgEventLog.append`）：JS 里只校验批内自洽（同会话、逐条 +1、首条 ≥ 1），**末尾一致性交给 SQL 的 WHERE**：

  ```sql
  INSERT INTO reins_events (...)
  SELECT $1, u.seq, ... FROM unnest($2::int[], ..., $6::json[]) AS u(...)
  WHERE (SELECT COALESCE(MAX(seq),0) FROM reins_events WHERE session_id = $1) = $7   -- $7 = first.seq - 1
  RETURNING seq
  ```

  `RETURNING` 回来 0 行 = 末尾不符 = 一条都没插，此时再查一次末尾拼出准确的 `expected` 抛 `seq_conflict`；两个写入者同时通过 WHERE 则撞主键 23505，同样翻成 `seq_conflict`。整个 append 是**一条语句**，不开事务、不借连接，所以传 `Pool` 进来也是对的。

**read / tail。** `read` 两边都按 `READ_PAGE = 500` 分页：`WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq LIMIT 500`，取回不足一页即结束，否则 `from += rows.length` 继续（依赖 seq 连续，这由 append 保证）。默认上界 SQLite 用 `Number.MAX_SAFE_INTEGER`、Postgres 用 `2_147_483_647`（`seq` 是 int4，超了会报类型错）。`tail` 用 `ORDER BY seq DESC LIMIT n` 再 `.reverse()` 成升序；`n` 非负整数校验不过抛 `invalid_argument`，`n = 0` 直接返回 `[]`。read 出来的事件都是 `JSON.parse` 的新对象，天然是副本。

**fork。** 契约相同（复制 `[1, atSeq]`，保留 `id` 与 `seq`，只换 `sessionId`；`atSeq` 越界 `out_of_range`，目标非空 `target_not_empty`），实现分岔：

- SQLite 在一个事务里做完检查与复制，复制是纯 SQL 的 `INSERT ... SELECT ... json_set(data, '$.sessionId', ?) ... WHERE session_id = ? AND seq <= ?`——数据不出库。
- Postgres 没法这么干：`json` 列没有 `jsonb_set`，而换成 `jsonb` 会重排键序（见下）。所以 `fork` 先 `read()` 出来、在 JS 里 `{...e, sessionId}`、再用与 append 同款的 `INSERT … SELECT unnest(...) WHERE NOT EXISTS (SELECT 1 FROM reins_events WHERE session_id = $1)` 整批插回——这个 WHERE 让"检查目标为空"和"写入"落在同一条语句里，检查与插入之间有人抢写也不会交错（插 0 行 → `target_not_empty`）。

**blob put / get / slice。** `put` 用 core 的 `uuidv7()` 生成 id，字符串按 UTF-8 `TextEncoder` 编码，记下 `size = byteLength` 与 `now()`。`get` 缺失抛 `not_found`，返回 `new Uint8Array(row.bytes)`（复制一份，不把驱动缓冲区交出去）。`slice(id, {start, end})` 把区间钳到非负后**在库内切**，不读整个 blob：SQLite `substr(bytes, ?, ?)`、Postgres `substring(bytes FROM $2 FOR $3)`，两者起点都从 1 起所以传 `start + 1`，长度不足自然截断。

**memory list 前缀查询。** 两边都**不用 `LIKE`**，免得给 `%` 和 `_` 转义：SQLite `WHERE substr(path, 1, ?) = ?`（参数是 `prefix.length` 与 `prefix`），Postgres `WHERE left(path, $2) = $1`。排序上 SQLite 默认就是字节序，Postgres 显式 `ORDER BY path COLLATE "C"`，两边与内存实现的字典序一致。`write` 是 upsert（`ON CONFLICT(path) DO UPDATE`），`delete` 天然幂等。

**装配与选项。** `sqliteStores(db, opts)` 同步返回 `Stores`，`pgStores(client, opts)` 返回 `Promise<Stores>`（建表要 await）。两者的 opts 一样有三项：`migrate`（缺省 `true`，起步幂等建表；自己管迁移的宿主传 `false`）、`memoryTable`（记忆表名，缺省 `reins_memory`，同时喂给建表语句与 MemoryStore；`SqliteMemoryStore` / `PgMemoryStore` 单独构造时对应 `table` 选项）和 `now`（缺省 `() => Date.now()`，注入给 BlobStore 与 MemoryStore 的时间戳；EventLog 不用它，事件的 `at` 由调用方带来）。`openSqlite(path, opts)` 另有 `wal`（文件库缺省开）与 `busyTimeoutMs`（缺省 5000），`:memory:` 不适用这两项，`PRAGMA foreign_keys = ON` 无条件开。

**表名：只有记忆表可配**（P2，2026-09-10）。`reins_events` / `reins_blobs` 是字面量，不可配——它们的隔离单位是 `session_id`，多个 agent 共用一份日志本就是设计；`reins_memory` 通过 `memoryTable` / `table` 换名，用于"多个角色共用一个库、各自一张记忆表"（技术方案 §9.6 隔离第一层）。表名字面拼进 SQL（参数绑定绑不了标识符），所以 `assertTableName` 白名单 `^[A-Za-z_][A-Za-z0-9_]{0,62}$` 是唯一一道防注入闸，两包各一份同一正则，不合规抛 `StoreError("invalid_argument")` 且不碰数据库；不加引号，Postgres 未加引号标识符统一折小写，DDL 与查询同一规则。

## 4 核心设计决策

- **一份 SQL、驱动由运行时给（S3）** — 只依赖 `{ exec, prepare }` 这个最小形状，`node:sqlite` 的 `DatabaseSync` 与 `bun:sqlite` 的 `Database` 天然满足，SQL 层一份不分叉。为什么：不用 better-sqlite3（原生编译、装机负担）也不用 sqlite-wasm（Node 下无持久化），零原生依赖。边界：Cloudflare 不走本包，Durable Objects SQLite 另起 `@reins/store-do`（第二期）。
- **Postgres 只认 `query(text, params) → { rows }`，且每个写都是单条语句** — pg 的 Pool / Client 与 PGlite 都直接满足，标签模板类库（postgres.js）包一层即可。为什么：单条语句在 Postgres 里天然原子，省掉"从池里借同一条连接跑 BEGIN/COMMIT"的复杂度，传连接池即正确。边界：这条约束反过来限制了实现——`fork` 因此不能用事务包"先查后插"，只能靠 `WHERE NOT EXISTS` 把守卫塞进同一条语句。
- **`data` 用 `json` 而不是 `jsonb`（B9）** — jsonb 会重排对象键序，读回来 `JSON.stringify` 就变了；而 T10 的 `pendingDigest` / `configHash` 正是按 `JSON.stringify` 算的，存 Postgres 的会话一续跑就会误报"pending 被篡改"。json 按文本原样存取，各后端逐字节一致。边界：代价是失去 jsonb 的索引与 `jsonb_set`，`fork` 只能在 JS 里改 sessionId。
- **seq 由调用方分配、存储层只校验连续性（T4）** — 日志不发号，只校验"同一批同会话、从末尾 +1 连续"，不符就 `seq_conflict`。为什么：存储层不知道 seq 该是多少，只有循环层知道；这样并发写入者会明确报错而不是静默交错，乐观并发就这么简单。边界：主键 `(session_id, seq)` 的唯一约束是最后一道闸（多进程 / 多实例），两边都把它翻译成同一个 `seq_conflict`。
- **fork 保留原事件 id（T4）** — 复制时只换 `sessionId`，`id` 与 `seq` 原样。为什么：`parentId` / `pinsKept` 这类会话内引用要继续有效。边界：事件 id 的唯一性范围因此是"会话内"而非全局。
- **一致性套件不绑测试框架（T4/T5）** — `@reins/core/testing` 只接收 `{ describe, it }`，断言自带（`ConformanceError`）。为什么：Bun、node:test 都能跑同一套件，第三方后端可自证合规。边界：套件里不能用 `expect`，特有行为测试才用 vitest。
- **测试缺省 PGlite，真库按需（B9）** — pg 包缺省用进程内 WASM Postgres 跑全套，设 `REINS_PG_URL` 才对真库再跑一遍。为什么：真 Postgres 引擎但不需要服务器，CI 免依赖。边界：dogfood 前必须在真库上绿过。
- **只让记忆表换名，事件表与 blob 表不可配（P2）** — `memoryTable` 只作用于 `reins_memory`。为什么：隔离需求只出现在记忆（按角色各一套），事件与 blob 按 `session_id` 隔离已足够，多开选项只会让"一个库多套 reins"这种未出现的场景提前定型；构造器从 `(db, now)` 改成 `(db, { table, now })` 选项对象，再加项不破坏签名。边界：真要整套隔离，用不同数据库 / schema（Postgres `search_path`）而不是表名前缀。
- **`removeNodeProtocol: false`（B11 附）** — store-sqlite 的 tsup 配置必须关掉这个缺省项。为什么：tsup 8 会把 `node:sqlite` 剥成裸的 `sqlite`（一个不存在的 npm 包），运行时 `ERR_MODULE_NOT_FOUND`；源码与 vitest 路径全绿完全掩盖了它，只有真跑 dist 才暴露。边界：所有含 `node:*` 子路径的包，验收都要加一条"跑一次 dist 产物"。
