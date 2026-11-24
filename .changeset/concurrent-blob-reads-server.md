---
"@reinsjs/server": minor
---

The image-reference pre-check reads metadata only: it calls `BlobStore.stat` when the store has one (falling back to `get`), so a message with N new images reads their bytes N times instead of 2N. With `midRunInput` on, a message that falls back from queuing to starting a run is no longer checked twice. If your `stat` disagrees with `get`, the loop's check (by `get`) wins and the request ends in `200` with an `error` frame instead of `400`.
