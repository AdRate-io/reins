---
"@reinsjs/core": minor
---

Folded media in user messages is now listed: new exports `foldedUserMedia(removed)` and `renderFoldedUserMedia(items, { heading, maxItems })` pick the user messages that carried images, video or audio out of a folded range, by `seq`. The default threshold summary (`defaultThresholdSummary`) appends such a list when the removed range contains one; summaries without media are unchanged.
