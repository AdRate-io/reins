---
"@reinsjs/core": minor
---

The conformance suites in `@reinsjs/core/testing` now test real concurrency: two concurrent `EventLog.append` calls with the same seq must land exactly one and reject the other with `seq_conflict`; eight owners acquiring a free `RunLease` at once must produce exactly one winner; and `BlobStore.put` must store a copy, so mutating the caller's buffer afterwards does not change the blob. A check-then-write backend used to pass. The old serial duplicate-seq case is renamed, as it never tested a concurrent writer. **Third-party backends that passed before may now fail these new cases** — that is the point: they flag real contract violations.
