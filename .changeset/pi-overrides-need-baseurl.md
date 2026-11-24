---
"@reinsjs/lowering-pi": minor
---

`anthropic()` / `openai()` now throw a `RangeError` when `contextWindow`, `maxOutputTokens`, `reasoning`, `images` or `midConversationSystem` is passed without `baseUrl`. These fields only describe the model behind a `baseUrl`; without one they were silently ignored and the capabilities still came from pi-ai's built-in table, so a host shrinking the window or declaring capabilities believed it had done so. The README now says this, and the `unsupported_model` error for a model the built-in table does not know points to `baseUrl` as well as the `models` option of `PiAiLowering`.
