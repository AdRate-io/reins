---
"@reinsjs/eval": minor
---

Gate: the governance rule now passes only when the violation rate does not rise under both the per-run mean and the rate pooled over actions. `ArmSummary.violations` gains `pooledBefore` / `pooledAfter` (total violations / total actions over the same compacted runs). Either measure alone can hide decay: a run with 2 actions before compaction can lift the per-run "before" mean, while runs with many actions dominate the pooled rate. The governance check reports the measure that failed and states the other one in its `note`.
