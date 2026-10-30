---
"@reinsjs/core": minor
---

Threshold truncation now cuts down to a lower watermark instead of just under the trigger line. Once the context passes `contextLimit - reserveTokens`, `budgetTruncate` removes the oldest turns until the context fits within `contextLimit × cutToRatio` (new option, default `0.6`; values above the trigger line fall back to it). Previously each truncation landed just under the line, so the next tool result pushed it back over: a sliver was cut almost every turn, the prompt cache prefix was invalidated each time, and summaries nested deeper. Pass `defaultProjectionChain({ truncate: { cutToRatio: 1 } })` to restore the old behavior.
