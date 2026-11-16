---
"@reinsjs/lowering-fetch": patch
---

Chat Completions: a turn that holds only thinking (cut off by a stop or a broken stream before any text or tool call) is no longer sent as an assistant message with neither `content` nor `tool_calls`. DeepSeek and OpenAI reject that message with 400, and because the timeline is replayed whole, every later request in the session failed. The whole turn is now left out and its thinking is declared `dropped` in the landings. Sessions already stuck on such a turn recover on the next request with no data repair.
