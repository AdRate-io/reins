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

const sql = postgres(process.env.DATABASE_URL)            // the instance you already hand to Drizzle is fine (tested)
const store = await pgStores(postgresJsClient(sql))
```

Tested against postgres.js 3.4 and 4.0. `postgresJsClient` only calls `sql.unsafe`, which never creates named prepared statements, so an instance with `prepare: false` (as used with transaction-mode poolers such as PgBouncer) behaves the same; PgBouncer itself is not in the test matrix. Pass the top-level `sql` returned by `postgres()`: a transaction from `sql.begin()` or a connection from `sql.reserve()` is rejected with `invalid_argument`, because it applies the instance's transforms without exposing them. Two limits:

- **No result transforms.** An instance created with `transform` — `postgres.camel`, a column mapper, or a custom `value` / `row` function — is rejected with `invalid_argument` when you call `postgresJsClient`. The stores read columns by their real names; `postgres.camel` turns `session_id` into `sessionId`, and blob metadata comes back incomplete. Give reins its own `postgres()` instance without `transform`. `transform.column.to` alone is allowed.
- **postgres.js 3 with `fetch_types: false`** sends arrays in a form Postgres rejects: every event append and fork fails with `22P02 malformed array literal` (blob and memory writes still go through). Keep the default, or use postgres.js 4.

Writing your own wrapper for another driver: bind parameters as given and return rows keyed by the column names in the SQL, with `data` (selected as `data::text`) left as a string. The stores never rely on the driver's JSON encoding (see below).

## Session status for a session list

`pgRunStates(client, sessionIds)` tells you, for up to 500 sessions in one SQL statement, whether each one is running, waiting on someone, failed or finished — without a status table of your own. It combines two facts that reins already keeps: the run lease in `reins_runs`, and the last run marker in the session's timeline (every run starts with `core.tools_bound` — unless it was aborted before it started — and ends with exactly one `core.run_paused` or `core.run_ended`). The classification itself is `runStatusOf` from `@reinsjs/core`, so a single-process host can use it directly with `runs.get(id) !== undefined` and `lastRunMarker(timeline)`.

```ts
/** One badge per session in a list. `lastReadAt` is your own "user opened it" timestamp. */
function badgeOf(status: RunStatus, lastReadAt: number): string {
  switch (status.state) {
    case "running":
      return "running"
    case "paused":
      return status.awaiting && status.awaiting.length > 0 ? "needs you" : "paused"
    case "error":
    case "interrupted":
      return "failed"
    case "done":
    case "handoff":
      return status.endedAt > lastReadAt ? "unread" : ""
    default:
      return "" // idle, or unknown (written by an older version or the TanStack adapter)
  }
}

/** Refuse to delete a session while a run holds it. */
async function canDelete(client: PgClient, sessionId: string): Promise<boolean> {
  const status = (await pgRunStates(client, [sessionId])).get(sessionId)
  return status?.state !== "running"
}
```

`paused.awaiting` lists the calls waiting on an answer from outside: an approval (with `requestedAt`, the time the request was written), a client tool (pending — not a promise the client has already received it), or a sub-agent (with its `childSessionId` — query that session for its own status). A user stop sets `stopped: true` and leaves `awaiting` empty. `paused.code` is the pause code, when the pause has one (`reins.budget`, `reins.compact_stalled`, `reins.max_turns`, or your own socket's, such as `acme.credits_exhausted`) — it is what was recorded at the moment of the pause, so a top-up afterwards does not change it. Use `seq` to tell one run's outcome from the next.

"Running" is only known for runs started through `@reinsjs/server`'s handler with a lease registry — `createAgent` with `pgStores` sets that up. `agent.run()`, sub-agent runs and the TanStack adapter take no lease: their outcomes show up, but while they run the session reads as `interrupted` or `unknown`. Other windows where the answer is briefly wrong:

- If the database stays unreachable until a lease expires while its run keeps going, the session reads `interrupted` until the next heartbeat renews it.
- If releasing a lease fails, the session reads `running` (and `canDelete` refuses) for up to the lease TTL, 30 s by default.
- After a process is killed mid-run, the session reads `running` until its lease expires, then `interrupted`.
- A session forked from the middle of a run inherits the unfinished run and reads `interrupted`.
- A resume that was already aborted when it started records your approval decisions but no `core.tools_bound`; if the process dies in the single write between those and its `core.run_paused`, the session still reads as the earlier `paused` approval.
- If a parent run that paused on a sub-agent is resumed and aborted (not stopped) before it starts, the new pause lists no sub-agent: the parent reads `paused` with reason `host` while the child session is still waiting.
- A session whose last run finished before this feature reads `unknown` (there was no end marker yet); one that paused reads `paused` with `awaiting` undefined.

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

Passes the conformance suite in `@reinsjs/core/testing` against PGlite directly and, in CI, against a PostgreSQL 16 server through `pg`, postgres.js 3 and 4, and the same two postgres.js versions after `drizzle(sql)` has rewritten their parsers and serializers. Locally the server columns run when `REINS_PG_URL` is set.

## Documentation

`docs/系统全景图_模块盘点/store.md` and `docs/archive/implementation-plans/2026-09-08-技术方案v1.0.md` §5 — in Chinese, at the repository root.

MIT © 2026 NewRate Limited.
