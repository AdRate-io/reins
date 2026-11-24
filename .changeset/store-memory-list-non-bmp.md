---
"@reinsjs/store-pg": patch
"@reinsjs/store-sqlite": patch
"@reinsjs/core": minor
---

`MemoryStore.list(prefix)` on Postgres and SQLite now matches prefixes containing characters outside the BMP (emoji, CJK extension B). The prefix length was bound as UTF-16 code units while the database counts characters, so such prefixes always returned an empty list. The MemoryStore conformance suite in `@reinsjs/core/testing` gains a case for it. **Third-party backends that passed before may now fail these new cases** — that is the point: they flag real contract violations.
