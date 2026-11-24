---
"@reinsjs/tools-mcp": patch
---

`mcpTools()` now warns once when one of its tools has a model-facing name that is already bound before it — by a host tool, another server, or a `@reinsjs/brain` module registered earlier such as `spill()`'s `fetch_blob`. The loop keeps the first tool of a name, so that server tool never reached the model and nothing said so; the warning names it and suggests `prefix`. The README's first example now registers the MCP socket after `spill()` and explains the ordering.
