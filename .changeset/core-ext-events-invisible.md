---
"@reinsjs/core": minor
---

`visibilityFilter` (and so the default projection) now drops `ext.*` events. No lowering sends them to the model, yet they stayed in the projected view and were counted in `stats.estimatedTokens`, the perception reading and the budget fallback — a large host extension event could trigger compaction or trimming while the real context was far from full. To show an extension event to the model, pass `filter: { keepExtEvents: true }` and translate it into a core event (a `core.system_note`, for example) in a strategy placed after the filter.
