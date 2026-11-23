---
"@reinsjs/brain": minor
---

`budget()` pauses with `code: "reins.budget"` (`BUDGET_PAUSE_CODE`; pass `code: (hits) => string` to compute your own; pause codes are lowercase, so lowercase a dimension name before using it) and `compact()` pauses on its consecutive-compaction limit with `code: "reins.compact_stalled"` (`COMPACT_STALLED_PAUSE_CODE`). Both still use `reason: "budget"`; the code is what tells them apart afterwards.
