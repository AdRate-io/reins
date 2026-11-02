---
"@reinsjs/core": minor
"@reinsjs/lowering-fetch": patch
"@reinsjs/lowering-pi": patch
---

Tool call arguments that the model double-encoded as a JSON string are now unwrapped one level on the read side when the inner value is a plain object, and the `core.tool_call` payload records `meta: { argumentsUnwrapped: true }`. Previously the tool received a string while the replayed history showed a valid object. core adds `unwrapToolArguments` / `toolCallArgumentsMeta` and the optional `ToolCallPayload.meta` field.
