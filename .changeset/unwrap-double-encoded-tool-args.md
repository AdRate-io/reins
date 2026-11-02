---
"@reinsjs/core": minor
"@reinsjs/lowering-fetch": patch
"@reinsjs/lowering-pi": patch
---

Tool call arguments that the model double-encoded as a JSON string are now unwrapped one level on the read side when the inner value is a plain object (tolerating raw control characters such as unescaped newlines inside string literals), and the `core.tool_call` payload records `meta: { argumentsUnwrapped: true }`. Arguments that do not decode to an object are stored as the original wire text, so `args` is a string only when it is exactly what the model sent; previously the tool could receive a string while the replayed history showed a different value. The Anthropic Messages line no longer replaces a string `content_block_start.input` with `{}`. core adds `decodeToolArgumentsText` / `unwrapToolArguments` / `toolCallArgumentsMeta` and the optional `ToolCallPayload.meta` field.
