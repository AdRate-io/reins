---
"@reinsjs/core": patch
---

A `needsApproval` function that throws no longer crashes the run. The call is treated as denied: it is not executed and gets an `isError` result `Approval check failed: …`. Before, the generator threw without a closing event and every later run hit the same error while completing the pending call.
