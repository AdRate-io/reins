---
"@reinsjs/core": patch
---

When a model response fails after some of its tool calls were already logged (the stream breaks, or ends with `stopReason: "error"`), the run now settles those calls with an `isError` result (`MODEL_FAILED_NOT_EXECUTED_TEXT`) in the same batch as the `core.error` and `run_ended(error)` events. Before, the calls stayed pending, and the next run executed them, possibly with truncated arguments, after the user's new message but before the model had read it.
