---
"@reinsjs/brain": patch
---

`memory()`: the `memory` tool now declares `replayable: false`. It stays `risk: "low"` (no approval), but `insert` / `str_replace` / `delete` / `rename` are not idempotent, so a call interrupted after it started is no longer re-run on resume; it settles as "outcome unknown" instead. Each memory call now writes a `core.tool_started` event before it executes.
