---
"@reinsjs/lowering-fetch": patch
---

A turn that contains a tool call no longer hides how it ended. On all three lines the stop reason is now decided in a fixed order: errors in the stream first, then a stream that never reached its terminal event, then truncation and refusals, and only last `toolUse`. Before, any tool call made the outcome `toolUse`, so a tool call cut off by `max_tokens` / `finish_reason: "length"` / `status: "incomplete"` reported `toolUse` instead of `length`, an Anthropic `refusal` or Chat `content_filter` after a tool call was swallowed, and a Chat or Anthropic stream that closed without `[DONE]` / `message_stop` (and without a finish reason) was treated as a normal tool turn instead of an `error`.

What this means for `@reinsjs/core`: with `length` the run still executes every tool call of the turn as before, including the cut-off one. With `error` the core retries only when the attempt produced no output; once tool call drafts were streamed it does not retry, and the run ends with `error` after closing those calls as not executed (see the `@reinsjs/core` changelog), so the next run on the session does not execute them.
