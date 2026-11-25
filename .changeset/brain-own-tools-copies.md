---
"@reinsjs/brain": patch
---

Copies of a module's own tools are no longer mistaken for someone else's. Modules that bring their own tools (`compact()`, `spill()`, `pins()`, `handoff()`, `memory()`, `skills()`, `lazyTools()`) recognised them by object identity, so a `beforeModel` patch that copies the tool table (for example `ctx.tools.map((t) => ({ ...t }))` to reword descriptions) silently switched them off: `spill()` stopped spilling, `handoff()` no longer ended the run, `lazyTools()` sent every lazy tool in full, all without a warning. A host that put a copy of a module's tool in its own `tools` was also treated as a name clash. A tool now counts as the module's own when it is the same object, or has the same name and the same `execute` function; a same-name tool with a different or wrapped `execute` still does not.
