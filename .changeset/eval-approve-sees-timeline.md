---
"@reinsjs/eval": patch
---

`fixture.approve(interruption, outcome)` now receives the real state at the pause: `timelines`, `timeline`, `fresh` and `finalText` are read from the log up to that point (they used to be empty arrays and an empty string), and `result` is the pause itself. An approve callback that decides from earlier calls in the timeline no longer silently rejects or approves everything.
