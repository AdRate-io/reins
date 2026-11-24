---
"@reinsjs/lowering-pi": patch
---

A signed thinking block recorded by a different model of the same provider and API is now declared `lossy` (`as-text`) instead of `exact`: pi-ai replays thinking only for the exact same provider, API and model, and turns the rest into plain text. Redacted or empty thinking from another model is declared `dropped`, since pi-ai removes it. The request itself is unchanged; only the declared landings now match what is sent.

On the OpenAI Responses line the same switch also loses what pi-ai replays only for the same model, and this is now declared too: text recorded with a `textSignature` lands `lossy` (its message id and phase are not replayed), a tool call carrying a `namespace` lands `lossy` (the namespace is dropped), and a tool call with an `fc_` item id stays `exact` with a note that the item id is not replayed.
