---
"@reinsjs/brain": patch
---

`skills()`: the "a tool named `skill_read` already exists" check now also covers tools contributed by sockets registered before `skills()` (for example an MCP server exposing `skill_read`), matching `lazyTools()`. Previously only host tools were checked, so the menu pointed the model at another socket's tool.
