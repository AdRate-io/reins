---
"@reinsjs/server": patch
---

The handler's resume pre-check now resolves Socket contributions with the request's `principal`, the same input the run itself starts with. A Socket that picks its tools from `setup.principal` no longer makes a legitimate resume fail with `409 config_mismatch` ("the definition of pending tool … differs"), and a client-side tool result for such a tool is no longer refused as a server-side tool.
