---
"@reinsjs/brain": patch
---

The default `budget()` pause note no longer promises a fresh budget for `contextTokens`. That limit is the size of the latest model request, and a resumed run inherits it from the log, so resuming does not reset it. Each turn is checked against the request that turn made, before any compaction in it takes effect, so a resumed run pauses at least once more, and the limit clears only once a later request is smaller (after the model compacts, or the session hands off). The note now says so when `contextTokens` is among the hit limits, and still says resuming starts a fresh budget for `totalTokens`, `turns`, `toolCalls` and `wallMs`. The README and the `BudgetLimits.contextTokens` docs say the same.
