---
"@reinsjs/lowering-pi": patch
---

`LOSS_MATRIX` now declares the landing of a `system_note` the host marked `trust: "untrusted"` whose text holds an early-closing `</untrusted`: `lossy` `system` on Anthropic, and `lossy` `developer` / `system` on OpenAI Responses (the tag is escaped). The request was already correct and the landing already said `lossy`; only the declaration was missing, so checks against the matrix failed on it.
