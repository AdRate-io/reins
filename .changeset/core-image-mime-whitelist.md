---
"@reinsjs/core": minor
---

Image parts must now use one of `image/jpeg`, `image/png`, `image/gif` or `image/webp`, inline or by reference. `isContentPart` rejects every other type, so an SVG or HEIC image from a tool can no longer enter the log and make every later request fail with a provider 400. The whitelist is exported as `SUPPORTED_IMAGE_MIMES` / `isSupportedImageMime` for other entry points to share. Breaking for hosts that wrote other image types: in a tool result, such a part (well formed apart from its type) is replaced by a sentence naming the type (`unsupportedImageText`) while the other parts are kept; `input` containing one throws `RangeError`. `@reinsjs/adapter-tanstack-ai` checks imported parts with `isContentPart`, so a client image of another type is now imported as its `[image(<mime>) part could not be imported …]` placeholder and listed in `dropped`.
