---
"@reinsjs/lowering-fetch": minor
---

`timeoutMs` (default 600 000 ms) no longer caps the whole streamed response. It now covers the wait for response headers and every gap between two stream frames, so a long answer or a long tool input that keeps streaming is not cut off at ten minutes. Before, with Anthropic's default `max_tokens` of 128 000, a slow turn could be aborted mid-stream and, because part of the output had already arrived, the run ended in an error without a retry. The official SDKs also only time the wait for headers; to cap the total time, abort with your own `signal`. `requestSignals()` now also returns `touch()` and `dispose()`, and the timeout message reads `request timed out: no data for <n>ms (…)`.
