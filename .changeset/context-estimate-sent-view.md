---
"@reinsjs/core": patch
"@reinsjs/adapter-tanstack-ai": patch
---

`budget_usage.contextEstimate` now estimates the view actually sent to the model, after `beforeModel` patches and the notes injected during `beforeModel`. Before, it was the projection estimate taken before injection, so a large injected note (such as a pins snapshot at a segment start) was counted as fixed overhead and then counted again on the next turn once it was in the timeline. That made the next turn's perception reading, compact's soft-line requests and the threshold fallback all overestimate the context, and could fold old turns while real usage was far below the line.
