---
"@reinsjs/core": minor
---

`visibilityFilter` (and so the default projection) now drops `ext.*` events. No lowering sends them to the model, yet they stayed in the projected view and were counted in `stats.estimatedTokens`, the perception reading and the budget fallback — a large host extension event could trigger compaction or trimming while the real context was far from full. To show an extension event to the model, build the chain with `defaultProjectionChain({ filter: { keepExtEvents: true } })`, insert a strategy of your own right after the filter (its first element) that translates the event into a core event (a `core.system_note`, for example), and pass the result as `projection.strategies` to `runLoop` / `createAgent`.
