---
"@reinsjs/lowering-fetch": patch
---

A turn that contains a tool call no longer hides how it ended. On all three lines the stop reason is now decided in a fixed order: errors in the stream first, then a stream that never reached its terminal event, then truncation and refusals, and only last `toolUse`. Before, any tool call made the outcome `toolUse`, so a tool call cut off by `max_tokens` / `finish_reason: "length"` / `status: "incomplete"` reported `toolUse` instead of `length`, an Anthropic `refusal` or Chat `content_filter` after a tool call was swallowed, and a Chat or Anthropic stream that closed without `[DONE]` / `message_stop` (and without a finish reason) was treated as a normal tool turn instead of an `error`.

What this does not change: `@reinsjs/core` still acts on the tool calls of such a turn. With `length` the run executes every tool call of the turn as before, including the cut-off one. With `error` the core retries only when the attempt produced no output; once tool call drafts were streamed it does not retry, the run ends with `error`, and the calls stay pending, so the next run on the session executes them without asking the model again. That is a known core bug, to be fixed in the core.
