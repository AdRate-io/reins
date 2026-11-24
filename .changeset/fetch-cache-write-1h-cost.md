---
"@reinsjs/lowering-fetch": patch
---

`costUsd` on Anthropic now prices 1-hour cache writes at the 1-hour rate. Before, every cache write was priced at the 5-minute rate (1.25× input), so with `anthropic.cacheTtl: "1h"` the cache-write part was under-reported by about 40%. The split comes from the provider's `usage.cache_creation` (`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`); when the upstream does not send it, writes count as 1-hour only if every cache breakpoint in the sent request is 1-hour; if your `requestOptions.cache_control` uses a different TTL from `cacheTtl`, they are priced at the 5-minute rate, so the cost may be under-reported but never over-reported. The 1-hour price is the new optional `ModelCost.cacheWrite1h`, defaulting to twice the input price. `costOf()` takes an optional third argument with the number of 1-hour write tokens.
