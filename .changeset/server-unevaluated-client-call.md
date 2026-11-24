---
"@reinsjs/server": patch
---

A client-side tool result is no longer accepted for a call the loop never evaluated. When a run is aborted by the host (a dropped connection with `onDisconnect: "abort"`, a lost lease) partway through a tool batch, the calls after the abort stay pending without ever reaching `beforeTool` or the approval check, so a client could fill in the result of a call that needs approval and skip both the approval and the approver's `authorizeSession` check. Filling in is now accepted only when the session's last run paused for external answers alone (no budget / host note, not a stop); otherwise the handler answers `409 call_not_evaluated`, and a `POST { sessionId }` without `input` lets the run evaluate the pending calls again before the result is sent.
