# @reins/store-sqlite

SQLite-backed `EventLog`, `BlobStore` and `MemoryStore` for [reins](../../README.md). One SQL layer, driver supplied by the runtime: Node 22.13+ ships `node:sqlite`, Bun ships `bun:sqlite`. The main entry has no `node:*` import and only needs an object with `exec(sql)` and `prepare(sql)`.

```bash
pnpm add @reins/store-sqlite
```

```ts
// Node
import { sqliteStores } from "@reins/store-sqlite"
import { openSqlite } from "@reins/store-sqlite/node"

const store = sqliteStores(openSqlite("./agent.db"))   // WAL on by default; ":memory:" for tests

// Bun
import { Database } from "bun:sqlite"
const store = sqliteStores(new Database("./agent.db"))
```

`sqliteStores(db, { memoryTable })` creates the tables if missing and returns `{ log, blobs, memory }`, ready for `createAgent({ store })`.

## Layout

| table | keyed by | notes |
| --- | --- | --- |
| `reins_events` | `session_id, seq` | append-only; `seq` must be contiguous per session (the store enforces it and throws `seq_conflict`) |
| `reins_blobs` | `session_id, id` | spilled tool results and other large payloads |
| `reins_memory` (configurable) | `path` | the model's memory files; `memoryTable` lets each role or tenant have its own table |

Table names are validated against `^[A-Za-z_][A-Za-z0-9_]{0,62}$` before any SQL is assembled — identifiers cannot be bound as parameters, so this whitelist is the injection guard. Only the memory table is renamable; events and blobs are isolated by `session_id` on purpose.

`fork(from, atSeq, to)` copies a session prefix verbatim (ids and `seq` preserved) into an empty session in one statement.

## Verified

Passes the conformance suite in `@reins/core/testing`. The published `dist` keeps the `node:sqlite` protocol prefix (tsup's default would strip it to a bare `sqlite`, which only fails at runtime — `pnpm check:dist` guards this).

Cloudflare Workers are not a target of this package; Durable Objects SQLite would be a separate store.

## Documentation

`docs/模块盘点/store.md` and `docs/技术方案.md` §5 — in Chinese, at the repository root.

MIT © 2026 NewRate Limited.
