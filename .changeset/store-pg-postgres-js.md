---
"@reinsjs/store-pg": minor
---

postgres.js support, and events now cross the wire only as text.

- **New `postgresJsClient(sql)`.** Turns a postgres.js instance (3.x or 4.x) into a `PgClient`: `pgStores(postgresJsClient(sql))`. It uses only `sql.unsafe`, so store-pg still has no runtime dependency, and you can pass the instance you already use (Drizzle-wrapped is fine, and tested). An instance created with a result `transform` (`postgres.camel`, a column mapper, custom `value` / `row`) is rejected with `invalid_argument`: those rename the columns the stores read. Pass the top-level `sql` from `postgres()`; a transaction or reserved connection is rejected too, since it applies the instance's transforms without exposing them.
- **Events are written as `text[]` and cast to `json` in SQL, and read back as `data::text`.** Before, they were bound as `json[]`, and postgres.js encoded the already-serialized string a second time, storing every event as a JSON string scalar (`json_typeof(data) = 'string'`). Reads still matched, so nothing failed, but SQL over `data` returned nulls. `pg` and PGlite store and return exactly what they did before. Rows already written as string scalars are still read correctly; new writes are JSON objects.
- The test matrix now runs the conformance suites against a real PostgreSQL 16 server in CI through `pg`, postgres.js 3 and 4, and Drizzle-wrapped postgres.js 3 and 4, as well as PGlite directly. A new check asserts what is stored, not just what reads back.
