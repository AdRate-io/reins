# @reinsjs/store-pg

PostgreSQL-backed `EventLog`, `BlobStore`, `MemoryStore` and `RunLease` for [reins](../../README.md). It needs exactly one method from your client — `query(text, params) → { rows }` — so `pg`'s `Pool` or `Client`, PGlite, and most pooled drivers work unchanged. No `node:*` imports.

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

## Layout and two deliberate choices

| table | keyed by | notes |
| --- | --- | --- |
| `reins_events` | `session_id, seq` | append-only, contiguous `seq` per session enforced in SQL (`seq_conflict` on violation) |
| `reins_blobs` | `session_id, id` | large payloads spilled out of the context |
| `reins_memory` (configurable) | `path` | the model's memory files; `memoryTable` gives each role or tenant its own table |
| `reins_runs` | `session_id` | run lease: `owner` and `expires_at`; acquire / renew / release are one statement each and expiry is judged by the **database clock** (`now()`), so instances with drifting clocks still agree on who holds a session |

- **`data` is `json`, not `jsonb`.** `jsonb` reorders object keys; reins hashes pending tool calls and configuration with `JSON.stringify`, and a resumed run compares those hashes against what it reads back. With `jsonb`, every resume of a Postgres-backed session would be flagged as tampered. `json` stores the text verbatim. The price is no `jsonb_set` and no JSON indexes — `fork` copies a session prefix by reading and re-inserting in JavaScript.
- **No transactions.** Every write is a single statement, so handing in a connection pool is correct by construction. Do not add read-then-write logic on top without revisiting this.

Table names are validated against `^[A-Za-z_][A-Za-z0-9_]{0,62}$` before any SQL is assembled; an invalid name throws `invalid_argument` and touches nothing. Only the memory table is renamable.

Passes the conformance suite in `@reinsjs/core/testing` (run against PGlite in CI).

## Documentation

`docs/模块盘点/store.md` and `docs/技术方案.md` §5 — in Chinese, at the repository root.

MIT © 2026 NewRate Limited.
