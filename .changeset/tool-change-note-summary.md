---
"@reinsjs/core": patch
---

Tool-change note: when more than 20 tools are added or removed at once (for example an MCP server's credentials expire), that side now lists 20 names and a total instead of every name. Names that appeared earlier in the session (called, referenced, or mentioned in model-visible text) are listed first. `meta.toolsChanged` still records the full diff, and notes with 20 or fewer changes per side are unchanged.
