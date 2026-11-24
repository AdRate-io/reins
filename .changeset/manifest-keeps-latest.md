---
"@reinsjs/core": patch
---

When the list of folded tool results (or of folded user messages with media) exceeds `maxItems`, it now keeps the most recent entries and collapses the older ones into a single `…N earlier (seq a–b)` line under the heading. It used to keep the oldest, so after a few compactions the results the model most likely wanted back were reduced to a bare seq range.
