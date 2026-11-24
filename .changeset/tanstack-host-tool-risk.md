---
"@reinsjs/adapter-tanstack-ai": minor
---

Host tools can now declare their risk to the brain: `toolDefinition({ …, metadata: { reins: { risk: "low" } } })` (type `ReinsToolMetadata`, also `replayable`). Before, the read-only view of a TanStack tool never carried a risk, so `approval()`'s default `byRisk` asked a human before every host tool call — the README's `approval({ ask: ["deploy"] })` paused on read-only tools too — and every call logged a `tool_started`. Tools without the declaration behave as before (fail-closed: asked about, not replayable); an invalid value is treated as undeclared and reported once through `warn`. `viewOfTanstackTool` takes an optional options object (`{ warn }`) as its second argument; it is an object rather than a function so that `tools.map(viewOfTanstackTool)`, which passes the array index there, stays harmless.
