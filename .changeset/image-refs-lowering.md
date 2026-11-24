---
"@reinsjs/lowering-fetch": minor
"@reinsjs/lowering-pi": minor
---

An image reference that reaches the lowering unhydrated (its blob was deleted, or no `BlobStore` is configured) is replaced with `[image unavailable]` and the event is recorded `lossy`, instead of sending a broken image. When the model takes no images the usual "this model does not accept images" placeholder is used, as for inline images. Loss matrices mention the new case.
