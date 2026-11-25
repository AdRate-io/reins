---
"@reinsjs/agent": minor
---

Carries `@reinsjs/core` 0.18 and `@reinsjs/server` 0.11, which `@reinsjs/agent` re-exports. Those releases contain breaking changes: HTTP `decisions` must be sent together with `resume` (400 otherwise), `decisions` only accept calls that are waiting for approval, `SessionAuthzInput` has a required `decisions` field, and image types outside the supported list (jpeg / png / gif / webp) are rejected with a `RangeError`. See those packages' changelogs before upgrading.
