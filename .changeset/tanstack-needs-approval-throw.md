---
"@reinsjs/adapter-tanstack-ai": patch
---

A reins tool whose `needsApproval` function throws is now handled as in `runLoop`: the call is not executed, the model gets `Approval check failed: <message>`, and a `core.error` (category `host`, `detail.phase: "needsApproval"`) records it for the host. Before, the error escaped `chat()` and left the tool call without a result, which later requests did not repair.
