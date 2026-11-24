---
"@reinsjs/eval": patch
---

`checkGate` also throws when an arm's `summary.runs` does not match the number of its cells in `report.outcomes`. The rules read the summary while the same-cells check reads the outcomes, so a report whose outcomes had been stripped to an empty list used to pass the same-cells check trivially.
