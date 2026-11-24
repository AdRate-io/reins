---
"@reinsjs/adapter-tanstack-ai": patch
---

TanStack's native lazy tools (`lazy: true`) now work within a run. After the model called the discovery tool, the middleware handed the engine its start-of-run tool list again on the next turn, overwriting the engine's updated list: the model never saw the discovered tool, and calling it anyway returned "Unknown tool". The middleware now adds tools the engine brings in mid-run (and drops the discovery tool once the engine does), placing them after the other host tools.
