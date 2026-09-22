---
"@reinsjs/core": minor
---

`SocketSetup.tools` — the tools bound so far when a socket's static contribution is resolved: the host's tools plus those of every socket registered before it, deduplicated (first name wins). `hostTools` is unchanged and still holds only the host's. Each socket now receives its own `SocketSetup` object (shared between its `tools` and `systemPrompt` resolution), so modules that cache "once per setup" keep working. This is what lets `lazyTools()` put tools contributed by earlier sockets — MCP servers — on its menu.
