---
"@reinsjs/core": minor
---

A `core.tool_result` draft in the initial `input` must now answer a call that is still pending and not waiting for approval: same `toolCallId` and `name`, at most once per batch. Otherwise `runLoop` throws `RangeError` before anything is written. Before, a host that submitted the same client-tool result twice, or a result for an unknown call, wrote a duplicate or orphan result that was replayed to the provider on every later request; and a result for a call still waiting for approval skipped the approval. Breaking for hosts that relied on either: pass the decision in `decisions` first, then the result. The HTTP handler already answers `409 unknown_tool_call` / `409 approval_pending` for these cases; unlike it, in-process `input` may still fill in a result for a server-side tool.
