---
"@reinsjs/adapter-tanstack-ai": patch
---

An image already in the log whose type is outside `image/jpeg`, `image/png`, `image/gif` and `image/webp` is no longer handed to TanStack AI as is (the provider would reject it on every request). Like the two lowering packages, the adapter puts the core `unsupportedImageText` sentence in its place and records the event `lossy`, declared in `TANSTACK_LOSS_MATRIX`.
