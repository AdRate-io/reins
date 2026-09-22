---
"@reinsjs/brain": minor
---

`lazyTools()` builds its menu from every tool bound before it (`SocketSetup.tools`), not only the host's — so tools contributed by an earlier socket, such as `mcpTools({ override: (t, info) => info.annotations?.readOnlyHint ? { ...t, lazy: true } : false })`, are disclosed on demand too. Register `lazyTools()` after the sockets that feed it; `lazy` tools from sockets registered later are still never hidden, and the module now warns once naming them. The "already has a tool named tool_find" check likewise looks at everything bound before it. `lazyMenuOf()` keeps its signature (the parameter was renamed).
