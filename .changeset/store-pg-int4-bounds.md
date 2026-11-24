---
"@reinsjs/store-pg": patch
"@reinsjs/core": minor
---

`PgEventLog.read` and `PgBlobStore.slice` now clamp bounds to the integer column range, matching the in-memory and SQLite stores: `toSeq: Number.MAX_SAFE_INTEGER`, `end: Infinity` and similar "to the end" values read to the end instead of throwing a raw Postgres error. The EventLog and BlobStore conformance suites in `@reinsjs/core/testing` gain cases for these bounds. **Third-party backends that passed before may now fail these new cases** — that is the point: they flag real contract violations.
