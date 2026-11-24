---
"@reinsjs/core": minor
---

`decisions` now only accept calls that are waiting for approval: pending, with a `core.approval_request` and no decision yet. A decision for a pending call that never asked for approval (for example one left over after the run was aborted mid-batch), or two decisions for the same call in one request, throws `RunStateError("unknown_tool_call")` before anything is written. Before, such a decision skipped `needsApproval`, the approval policy's `defer` and its `ttl`. The check is exported as `assertDecisionsAwaitApproval` so the HTTP handler can share it. To drop a pending call that is not waiting for approval, stop the run instead.
