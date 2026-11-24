---
"@reinsjs/eval": patch
---

`gradeExpect` (and so every planted fact graded by a regular expression) no longer depends on how often the same `RegExp` was used before. A fact written as `expect: /\b14\b/g` used to score the same correct answer 1, 0, 1, … across arms and repeats because `test` advanced `lastIndex`; the `g` and `y` flags are now ignored for grading and the caller's `RegExp` is left untouched.
