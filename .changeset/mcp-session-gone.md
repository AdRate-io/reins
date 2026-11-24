---
"@reinsjs/tools-mcp": patch
---

Rebuild the MCP connection when a stateful Streamable HTTP server answers 404 for an expired session (server restart, session TTL). Previously the stale session id was reused forever, so every later run failed at `tools/list` until the host called `close()`. `tools/list` now re-initializes and lists again in the same call; a `tools/call` that hits the 404 is still reported as an error (not resent) and the next call reconnects. Other calls already in flight on the expired connection are left to finish; the old client is closed once they settle.
