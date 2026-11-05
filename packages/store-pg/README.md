# @reinsjs/store-pg

PostgreSQL-backed `EventLog`, `BlobStore`, `MemoryStore` and `RunLease` for [reins](../../README.md). It needs exactly one method from your client — `query(text, params) → { rows }` — so `pg`'s `Pool` or `Client` and PGlite work unchanged, and postgres.js goes through `postgresJsClient`. No `node:*` imports.

```bash
pnpm add @reinsjs/store-pg
```

```ts
import { pgStores } from "@reinsjs/store-pg"
import pg from "pg"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const store = await pgStores(pool)                     // creates tables if missing
const perRole = await pgStores(pool, { memoryTable: "analyst_memory" })
```

`pgStores` returns `{ log, blobs, memory, runLease }`, ready for `createAgent({ store })` — with `runLease` present, `createAgent` makes the "one run per session" guard hold across instances (see `@reinsjs/server`, "Multiple instances"). Drop the key if you run a single process and would rather not have the heartbeat write. PGlite (`new PGlite("./data")`) is a drop-in for local development and tests — `examples/team` uses it.

### postgres.js

```ts
import { pgStores, postgresJsClient } from "@reinsjs/store-pg"
import postgres from "postgres"

const sql = postgres(process.env.DATABASE_URL)            // the instance you already hand to Drizzle is fine
const store = await pgStores(postgresJsClient(sql))
```

Tested against postgres.js 3.4 and 4.0, including `prepare: false` (transaction-mode poolers such as PgBouncer). Two limits:

- **No result transforms.** An instance created with `transform` — `postgres.camel`, a column mapper, or a custom `value` / `row` function — is rejected with `invalid_argument` when you call `postgresJsClient`. The stores read columns by their real names, and `postgres.camel` also rewrites keys inside JSON values, which would change stored events and break resume checks. Give reins its own `postgres()` instance without `transform`. `transform.column.to` alone is allowed.
- **postgres.js 3 with `fetch_types: false`** sends arrays in a form Postgres rejects (`22P02 malformed array literal`) on the first write, and nothing is stored. Keep the default, or use postgres.js 4.

Writing your own wrapper for another driver: bind parameters as given and return rows keyed by the column names in the SQL. The stores never rely on the driver's JSON encoding (see below).

## Layout and two deliberate choices

| table | keyed by | notes |
| --- | --- | --- |
| `reins_events` | `session_id, seq` | append-only, contiguous `seq` per session enforced in SQL (`seq_conflict` on violation) |
| `reins_blobs` | `session_id, id` | large payloads spilled out of the context |
| `reins_memory` (configurable) | `path` | the model's memory files; `memoryTable` gives each role or tenant its own table |
| `reins_runs` | `session_id` | run lease: `owner` and `expires_at`; acquire / renew / release are one statement each and expiry is judged by the **database clock** (`now()`), so instances with drifting clocks still agree on who holds a session |

- **`data` is `json`, not `jsonb`, and it only crosses the wire as text.** `jsonb` reorders object keys; reins hashes pending tool calls and configuration with `JSON.stringify`, and a resumed run compares those hashes against what it reads back. With `jsonb`, every resume of a Postgres-backed session would be flagged as tampered. `json` stores the text verbatim. Events are bound as `text[]` and cast to `json` inside the statement, and read back as `data::text`, so no driver's JSON encoder or parser touches them — binding as `json[]` makes postgres.js encode the already-serialized string a second time. The price is no `jsonb_set` and no JSON indexes — `fork` copies a session prefix by reading and re-inserting in JavaScript.
- **No transactions.** Every write is a single statement, so handing in a connection pool is correct by construction. Do not add read-then-write logic on top without revisiting this.

Table names are validated against `^[A-Za-z_][A-Za-z0-9_]{0,62}$` before any SQL is assembled; an invalid name throws `invalid_argument` and touches nothing. Only the memory table is renamable.

Passes the conformance suite in `@reinsjs/core/testing` — in CI against PGlite directly and against postgres.js 3 and 4 over the wire (PGlite behind `@electric-sql/pglite-socket`); with `REINS_PG_URL` set, also against a real server through `pg` and both postgres.js versions.

## Documentation

`docs/系统全景图_模块盘点/store.md` and `docs/archive/implementation-plans/2026-09-08-技术方案v1.0.md` §5 — in Chinese, at the repository root.

MIT © 2026 NewRate Limited.
