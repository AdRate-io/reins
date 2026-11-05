---
"@reinsjs/brain": patch
---

perception: a `contextTokens` limit at or above the model's context window (`contextLimit`) no longer counts toward "Run budget remaining". A single request cannot exceed the window, so that limit's remaining share just restated the context-usage line. Limits below the window are still reported. With only such a context limit configured, the budget line is omitted.
