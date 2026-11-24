---
"@reinsjs/eval": minor
---

`checkGate` now throws when the reference and candidate arms do not cover exactly the same fixture × repeat cells, or when one arm has the same cell twice. Every gate rule compares per-run means, so a candidate missing its most expensive cells (for example a crashed process when arms are run separately) used to pass the token rule on a different set of tasks without any warning.
