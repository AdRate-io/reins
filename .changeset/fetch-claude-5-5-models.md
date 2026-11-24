---
"@reinsjs/lowering-fetch": minor
---

The built-in table now has `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` and `claude-fable-5-2` with their 1M context window, 128K output and official prices. Before, these ids fell back to the conservative defaults for unknown models (128k window, 16k output, no `costUsd`), so context management folded far too early and the default `max_tokens` was 16 384. `claude-haiku-5-5` is priced by prompt length; the table stores the rate for prompts up to 100K tokens, so `costUsd` is a lower bound above that.

Mid-conversation `system` now also covers Sonnet 5.5 and Haiku 5.5 (Sonnet 5 still does not), and `capabilities.taskBudget` follows the provider's current list: Fable 5.x, Mythos 5.x, Opus 5 / 5.5 / 4.8 / 4.7, Sonnet 5.5 and Haiku 5.5.
