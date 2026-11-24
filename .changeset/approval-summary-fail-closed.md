---
"@reinsjs/brain": patch
---

`approval()`: a rule's `summary()` that throws is now treated like a throwing `match()` — the call is denied (fail-closed) with the rule id as `by`, instead of the error escaping `runLoop` and leaving the call pending for every later run.
