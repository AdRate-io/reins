---
"@reinsjs/core": minor
---

Image parts must now use one of `image/jpeg`, `image/png`, `image/gif` or `image/webp`, inline or by reference. `isContentPart` rejects every other type, so an SVG or HEIC image from a tool can no longer enter the log and make every later request fail with a provider 400. The whitelist is exported as `SUPPORTED_IMAGE_MIMES` / `isSupportedImageMime` for other entry points to share. Breaking for hosts that wrote other image types: a tool result containing one is turned into JSON text, and `input` containing one throws `RangeError`.
