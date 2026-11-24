---
"@reinsjs/adapter-tanstack-ai": patch
---

The TanStack path neither checks nor loads blobs: an image reference becomes `[image unavailable]` and the user message or tool result is recorded `lossy`, and image references in tool results (from reins tools or `afterTool`) are replaced with that text before they are logged, so this path never writes an unchecked reference (now also declared in `TANSTACK_LOSS_MATRIX`, together with escaped tool results). Use `runLoop` when the model must see referenced images.
