---
"@reinsjs/lowering-pi": patch
---

`tool_reference` content parts (new in `@reinsjs/core`) are rendered as text and tools marked `deferLoading` are not sent — pi-ai's request shaping has no place for Anthropic's `defer_loading`; capabilities report `deferredTools: false`.
