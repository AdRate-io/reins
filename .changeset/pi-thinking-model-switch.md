---
"@reinsjs/lowering-pi": patch
---

A signed thinking block recorded by a different model of the same provider and API is now declared `lossy` (`as-text`) instead of `exact`: pi-ai replays thinking only for the exact same provider, API and model, and turns the rest into plain text. Redacted or empty thinking from another model is declared `dropped`, since pi-ai removes it. The request itself is unchanged; only the declared landings now match what is sent.
