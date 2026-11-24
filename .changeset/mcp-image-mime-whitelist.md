---
"@reinsjs/tools-mcp": patch
---

An MCP `image` block, or an embedded `image/*` resource, whose type is not `image/jpeg`, `image/png`, `image/gif` or `image/webp` (an SVG chart, a TIFF, a mislabeled `application/octet-stream`) now becomes the text `unsupportedImageText(mime)` from `@reinsjs/core` in `toContentParts`, checked with `isSupportedImageMime`. Before, any string `mime` was passed through as an image part; providers reject such parts with a 400, and core had to replace them later with the same sentence. Supported images are unchanged.
