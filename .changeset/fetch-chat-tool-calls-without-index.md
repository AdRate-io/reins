---
"@reinsjs/lowering-fetch": patch
---

Chat Completions: when an OpenAI-compatible upstream omits `index` on streamed `tool_calls`, parallel calls are no longer merged into one. A delta with a new, different `id` starts a new call; a delta without an `id` continues the current one. Before, every such delta went to slot 0, so the earlier call disappeared and the last tool received both argument strings joined together.
