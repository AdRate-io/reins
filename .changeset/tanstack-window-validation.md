---
"@reinsjs/adapter-tanstack-ai": patch
---

`reinsMiddleware()` now checks `capabilities.contextWindow` and `projection.reserveTokens` when it is created, with the same check as `runLoop` (`resolveReserveTokens`), and throws a `RangeError` for a bad window or reserve. Before, the error only surfaced at the first projection, after `tools_bound` and the imported user messages were already in the log, so the session looked interrupted.
