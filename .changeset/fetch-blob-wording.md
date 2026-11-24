---
"@reinsjs/core": patch
"@reinsjs/brain": patch
---

The folded-results list, `recall`'s answer for a spilled result and the `recall` tool description now say the same thing about spilled outputs: read them with `fetch_blob` "if that tool is in your tool list". The list used to state it unconditionally, though a run may not have `fetch_blob` (`spill({ tool: false })`, or spill removed later).
