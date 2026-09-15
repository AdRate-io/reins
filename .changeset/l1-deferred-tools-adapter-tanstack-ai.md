---
"@reinsjs/adapter-tanstack-ai": patch
---

`tool_reference` content parts (new in `@reinsjs/core`) are rendered as text when translating to TanStack messages and tool results; capabilities report `deferredTools: false`.

`capabilities.deferredTools` is forced to `false` on this path even when the host passes `true`: TanStack's adapter decides how tools reach the provider, so there is no place for `defer_loading` / `tool_reference` and `BeforeModelPatch.deferredTools` is not read; `lazyTools()` always takes its filtering path here. `approval({ ttlMs })` is verified to work on this path (the engine re-enters the `beforeTools` boundary after an interrupt is resolved), with a test locking the event sequence.
