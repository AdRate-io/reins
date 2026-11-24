---
"@reinsjs/brain": patch
---

The default `budget()` pause note no longer promises a fresh budget for `contextTokens`. That limit is the size of the latest model request, and a resumed run inherits it from the log, so resuming does not reset it: unless the context shrinks first (the model compacts, or the session hands off), the run pauses again after its next turn. The note now says so when `contextTokens` is among the hit limits, and still says resuming starts a fresh budget for `totalTokens`, `turns`, `toolCalls` and `wallMs`. The README and the `BudgetLimits.contextTokens` docs say the same.
