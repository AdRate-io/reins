---
"@reinsjs/core": patch
---

When a resumed run locates the batch of leftover tool calls, an `ext.*` event between two calls of the same model response no longer splits the batch, matching how the lowerings group that response (extension events do not break an assistant turn there).
