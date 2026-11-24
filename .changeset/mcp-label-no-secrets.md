---
"@reinsjs/tools-mcp": minor
---

Keep secrets out of transport labels. `httpTransport` now defaults its label to the URL's origin (it used to keep the path, where several hosted MCP services put the API key) and `stdioTransport` to the bare command (it used to include every argument, such as `--api-key …`). The label names the socket (`mcp:<label>`) and appears in connection errors, which can reach the model as an error result and stay in the log. Both recipes accept an explicit `label` option for a friendlier name; an empty label is rejected at construction. `Socket.name` changes for existing configurations (`mcp:https://host/path` → `mcp:https://host`); it does not feed the config hash, so paused runs still resume.
