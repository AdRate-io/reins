---
"@reinsjs/eval": minor
---

Gate: the governance rule no longer lets runs that never compacted dilute the after-compaction violation rate. `ArmSummary.violations` is now computed only over runs that had model actions after their first compaction (both windows over the same runs) and gains `compactedRuns`; when it is 0 the governance check passes with a `note` instead of silently. Previously a candidate whose only compacted run got worse could still pass because the other runs counted as a 0% after-rate. `renderReport` shows the run count next to the rates.
