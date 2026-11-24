---
"@reinsjs/server": patch
---

README: the image route recipe ("Images by reference") now serves only raster formats (PNG, JPEG, GIF, WebP) and sends `x-content-type-options: nosniff` and `content-security-policy: default-src 'none'; sandbox`. The earlier recipe served any `image/*` blob with its stored type, so a session's owner could reference an `image/svg+xml` blob whose scripts would run on your origin with the credentials of whoever opened it, such as an approver. If you copied the recipe, update your route.
