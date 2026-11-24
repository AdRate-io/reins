---
"@reinsjs/core": patch
"@reinsjs/adapter-tanstack-ai": patch
---

`ext.*` events a socket writes during `beforeModel` no longer join that turn's view. They are not sent to the model, but they were counted in the estimate of what was sent, so the calibrated fixed overhead (`contextOverheadOf`) came out too low. "Hidden from the model by default" now has one definition, exported as `isModelInvisibleByDefault` (the operational event types plus the `ext.` prefix), used by `visibilityFilter`, `runLoop` and the TanStack AI middleware.
