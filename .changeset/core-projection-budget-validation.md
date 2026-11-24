---
"@reinsjs/core": minor
---

`project()` now rejects a bad context window or reserve with a `RangeError`: `contextLimit` must be a positive finite number, and `reserveTokens` must be a non-negative finite number below `contextLimit`. Before, a `NaN` or `0` window, or a reserve not below the window, made the threshold fallback fold everything but the last turn and write that compaction into the append-only log for good, and with `NaN` it did not even report `overBudget`. `runLoop` runs the same check on the model's `contextWindow` and `projection.reserveTokens` before it writes anything. The check is exported as `resolveReserveTokens`, which also returns the default reserve.
