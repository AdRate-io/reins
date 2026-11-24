---
"@reinsjs/core": minor
---

The EventLog conformance suite in `@reinsjs/core/testing` now checks that every shell field round-trips verbatim — `parentId`, `provenance`, nested `replay` (thinking signatures, reasoning item ids), non-ASCII and large payloads, a non-current `schemaVersion` and `ext.*` types — through `read`, `tail` and `fork`. A backend that stored only some columns used to pass the suite while silently breaking reasoning replay. New helper `makeRichEvents(sessionId, startSeq?)`. **Third-party backends that passed before may now fail these new cases** — that is the point: they flag real contract violations.
