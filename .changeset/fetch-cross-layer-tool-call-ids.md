---
"@reinsjs/lowering-fetch": patch
---

Tool call ids recorded by another lowering layer are now translated on the way out, so a timeline written by `@reinsjs/lowering-pi` keeps working after switching to this package. On Anthropic, `tool_use.id` and `tool_result.tool_use_id` are mapped to the provider's character set and cut to 64 characters, the same rule pi-ai applies; before, pi's OpenAI Responses ids such as `call_x|fc_y` were sent as is and every later request of that session was rejected. On OpenAI Responses, pi's composite id is split back into `call_id` and the `fc_` item id. Ids produced by this package are unchanged.
