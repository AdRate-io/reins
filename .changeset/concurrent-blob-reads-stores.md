---
"@reinsjs/store-sqlite": minor
"@reinsjs/store-pg": minor
---

`BlobStore.stat(id)` returns a blob's metadata without reading the bytes column (same row conversion as `get`, `not_found` for an unknown id). `@reinsjs/server` uses it for the image-reference pre-check.
