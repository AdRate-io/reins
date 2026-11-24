---
"@reinsjs/lowering-fetch": patch
---

Provider errors that arrive with status 200 are no longer reported as a retryable "stream ended before finish_reason". An `error` frame inside a Chat Completions stream (`data: {"error": {...}}`, common on OpenAI-compatible relays) now ends the turn with `"<code>: <message>"` carrying the provider's text, like the Anthropic and Responses lines. A 2xx response whose `content-type` is JSON (a gateway answering an auth or quota error with status 200) now throws `HttpError` with the raw body on all three lines, and is not retried.
