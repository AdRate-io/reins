---
"@reinsjs/lowering-fetch": patch
"@reinsjs/lowering-pi": patch
---

An image whose type is outside `image/jpeg`, `image/png`, `image/gif` and `image/webp` (`isSupportedImageMime` in `@reinsjs/core`) is no longer sent to the provider. Such images can still sit in logs written before core started rejecting them, and every request replays them, so one SVG made the whole session fail with a provider 400. All three wire protocols and the pi-ai lowering now put the core `unsupportedImageText` sentence in its place and record the event `lossy` (declared in each loss matrix); on Chat, such an image in a tool result is not lifted into the follow-up user message. Requests with only supported images are byte-identical to before.
