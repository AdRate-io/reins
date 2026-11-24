---
"@reinsjs/adapter-tanstack-ai": patch
---

`reinsApprovalInterrupt` answers are now recorded only for calls of this session that are waiting for approval (an `approval_request` and no decision yet, at most one answer per call), the same check `runLoop` and the server apply. TanStack does not sign generic-interrupt continuations, so a client could copy a valid entry, change its `key`, and get an `approval_decision` written for any id, including one the model had not produced yet; when the model later emitted that id, the call ran without being asked about. Such answers are now dropped with a warning.
