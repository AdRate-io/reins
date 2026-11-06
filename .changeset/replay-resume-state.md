---
"@reinsjs/core": minor
"@reinsjs/server": minor
"@reinsjs/ui-agui": minor
---

A paused run can now be resumed from a replay, not only from the stream that saw it pause. The signed resume state is written into the `core.run_paused` event (`payload.state`, model-invisible — the same object as `RunResult.state`), and a replay-only stream whose session ends at that pause carries it in the `end` frame (`state`); with `@reinsjs/ui-agui` it is `RUN_FINISHED.result.state` next to `status: "replayed"`. A page reloaded, reopened or opened on another device can therefore still approve or reject. The state is the one signed at the moment of the pause — never recomputed when read — so configuration drift is still caught. The frame carries the state of the latest pause whatever its reason (approval, budget, abort, stop); decide whether to show an approval card from `state.pendingToolCallIds` and the replayed `core.approval_request` events — after a stop the list is empty. New helper `pausedStateOf(lastEvent)` in `@reinsjs/core` returns the state when the given (last) event is such a pause.
