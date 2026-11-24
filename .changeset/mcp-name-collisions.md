---
"@reinsjs/tools-mcp": patch
---

Keep model-facing MCP tool names unique. When rewriting an invalid name (`files.delete` → `files_delete`) or truncating to 64 characters lands on a name another tool of the same server already uses, the rewritten tool now gets a `_2`, `_3`… suffix (assigned in order of the original names, not the server's listing order) and the warning names the clash. Previously both tools carried the same name and the loop silently dropped one of them, while the only warning pointed at the other.
