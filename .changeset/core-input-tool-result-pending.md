---
"@reinsjs/core": patch
---

A `core.tool_result` draft in the initial `input` must now answer a call that is still pending: same `toolCallId` and `name`, at most once per batch. Otherwise `runLoop` throws `RangeError` before anything is written. Before, a host that submitted the same client-tool result twice, or a result for an unknown call, wrote a duplicate or orphan result that was replayed to the provider on every later request. This matches the HTTP handler, which already answers `409 unknown_tool_call`.
