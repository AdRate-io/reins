---
"@reinsjs/server": minor
---

`input` may carry image references (`{ type: "image", mime, blobId }`). The handler checks them with core's `checkImageRefs` before it queues a message during a run or starts a run: a reference to a missing blob, another session's blob, a blob with a different `mime`, or with no `BlobStore` gets `400` (`Blob <id> not found in this session`) and nothing is written; a storage error while checking gets `503 storage_unavailable`. The README shows how to serve the image bytes from your own route with `blobUsableBy`.
