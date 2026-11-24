---
"@reinsjs/server": patch
---

An `image` part sent over HTTP (inline or by reference, in an array `input` or in a `core.user_message` / `core.tool_result` draft) must now have a `mime` of `image/jpeg`, `image/png`, `image/gif` or `image/webp`, checked with `isSupportedImageMime` from `@reinsjs/core`; anything else answers `400` and nothing is written. Before, an inline image only needed a string `mime`, so an SVG or a mislabeled file passed the handler and then failed inside the run, giving `200` with an `error` frame instead of `400`.
