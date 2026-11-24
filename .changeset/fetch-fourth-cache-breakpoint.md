---
"@reinsjs/lowering-fetch": patch
---

Anthropic: when a breakpoint slot is free, a fourth cache breakpoint now goes where the previous request ended (the last block of the `user` message before the latest assistant turn). The provider looks back only about 20 blocks from each breakpoint, so after a turn with ten or more parallel tool calls the whole conversation history used to miss the cache and be written again. The system, tools and last-user breakpoints keep priority, and the total never exceeds four.
