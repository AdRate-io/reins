---
"@reinsjs/tools-mcp": patch
---

A `tools/call` without `route` that is stopped while the dropped connection is being rebuilt now reports `ROUTE_NOT_SENT_TEXT` ("Not executed: …") instead of letting the loop record "outcome unknown". The request never reached the server; routed calls already behaved this way.
