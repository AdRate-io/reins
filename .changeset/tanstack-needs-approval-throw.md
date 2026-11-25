---
"@reinsjs/adapter-tanstack-ai": patch
---

A reins tool whose `needsApproval` function throws is now handled as in `runLoop`: the call is not executed, the model gets `Approval check failed: <message>`, and a `core.error` (category `host`, `detail.phase: "needsApproval"`) records it for the host. Before, the error escaped `chat()` and left the tool call without a result, which later requests did not repair.

Client-side reins tools contributed by a socket (no `execute`) are now cancelled through the engine when a socket blocks them, an approval is denied, or the check above fails, like the host's own client tools. Before, only the host's TanStack client tools were recognised, so the engine still handed such a call to the frontend and the result it sent back was then replaced by the block message.
