---
"@reinsjs/tools-mcp": minor
---

Pick a credential per `tools/call` on one MCP server: `mcpTools({ transport, route: { keyOf(call, ctx), transportFor(key) } })`.

- `transport` stays the catalog connection: `tools/list` runs on it once per run start and `optional` applies to it alone. `route` is not part of the tool table or config hash, so changing routing rules is not configuration drift.
- Each call asks `keyOf` for a key and runs on a per-key connection from a pool owned by the socket (lazy, reused across runs, rebuilt once after a drop). Each key's recipe carries its own `auth`, so a 401 refreshes that identity alone.
- `keyOf` returning anything but a non-empty string, or throwing, means the call is not sent; it never falls back to the catalog connection. A thrown message reaches the model verbatim.
- If the run is aborted before the call is sent (in `keyOf`, `transportFor` or a new key's handshake), the model gets `ROUTE_NOT_SENT_TEXT` ("Not executed: …") rather than the loop's "outcome unknown" text.
- New `McpToolsSocket.evict(key)`: removes a key from the pool at once and closes its connection after the calls in flight on it finish. `close()` now also closes every pooled connection, evicted ones still draining included. Hand-written test doubles of `McpToolsSocket` need an `evict` method.
- The pool is shared by every session that reaches the socket: `keyOf` is the only authorization point. See the README section "Several credentials on one server".
