---
"@reinsjs/brain": patch
---

A `beforeModel` patch that copies the tool table (for example `ctx.tools.map((t) => ({ ...t }))` to reword descriptions) no longer silently switches off modules that bring their own tools. Their hooks recognised the tool by object identity, so a copy looked like someone else's tool: `spill()` stopped spilling and `handoff()` no longer ended the run, without any warning. A copy that keeps the same `execute` function now counts as the module's own tool; a same-name tool with a different or wrapped `execute` still does not.
