---
"@reinsjs/store-pg": minor
---

`PgRunLease` — a `RunLease` on a new `reins_runs(session_id, owner, expires_at)` table, added to the schema and to `pgStores()`. Acquire, renew and release are one statement each (no transactions, pool-safe like the rest of the package) and expiry is decided by the database clock, so instances with drifting clocks agree on who holds a session.
