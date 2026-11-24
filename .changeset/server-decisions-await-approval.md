---
"@reinsjs/server": patch
---

The handler's check of `decisions` now uses the same rule as `runLoop` (`assertDecisionsAwaitApproval`): a decision for this session must point at a call that is waiting for approval, not just at any pending call. Before, approving a pending call that never asked for approval (a client-side tool, or a call later in a batch that was aborted) passed the HTTP check and then failed inside the run, so the client got `200` with an `error` frame instead of `409 unknown_tool_call`. When this check fails while another run of the session is active in this process, the answer is `409 run_in_progress`, as before.
