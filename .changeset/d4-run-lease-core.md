---
"@reinsjs/core": minor
---

New store interface `RunLease` (`acquire` / `renew` / `release`) and optional `Stores.runLease` — a lease table that lets the "one run per session at a time" guard span processes. Expiry is judged by the store's own clock, `acquire` is idempotent for the same owner, and none of the three methods throw on contention (they answer with a boolean). `InMemoryRunLease({ now })` is the reference implementation (not included in `memoryStore()`, which stays single-process), and `runLeaseConformance` joins the other suites in `@reinsjs/core/testing`.
