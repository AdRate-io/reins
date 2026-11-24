---
"@reinsjs/adapter-tanstack-ai": patch
---

A socket block on a client tool (one without `execute`, including an `approval()` deny or a rewrite of a call on TanStack's native approval card) now stops the call: the middleware adds it to the engine's `cancelledToolCallIds` at the `beforeTools` boundary, so the client is never asked to run it. Previously the engine still handed the call to the client, and when the client's result came back it was logged as "Tool call blocked … not executed", replacing what had really happened. If the block cannot be enforced (a middleware placed before reins replaces the engine's cancel set with a copy), the real result is now logged as it came back, followed by a `core.error` (category `tanstack-ai`, not shown to the model) saying the block was not enforced.
