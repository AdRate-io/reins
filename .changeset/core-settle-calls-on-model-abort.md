---
"@reinsjs/core": minor
---

When the host aborts a model response (a dropped connection or a lost lease, not a user stop) after some of its tool calls were already logged, the run now settles those calls with an `isError` result (`MODEL_INTERRUPTED_NOT_EXECUTED_TEXT`) before pausing as `paused(host)`. This covers both a response that ends with `stopReason: "aborted"` and a stream that throws after the host aborted. Before, the calls stayed pending, and the next run executed them, possibly with arguments cut off mid-stream, after the user's new message but before the model had read it. A user stop is unchanged: those calls get the usual stop text. Behavior change for hosts that relied on resuming such a call: the model now sees that it was dropped and decides whether to call again.
