---
"@reinsjs/brain": minor
---

`recall({ seq })` also brings back a folded user message verbatim, media included, so a screenshot the user pasted earlier is no longer lost once `compact` folds it. A compaction summary gets a second list (`MEDIA_MANIFEST_HEADING`) of folded user messages that carried images, video or audio, the receipt counts them, and the `compact` / `recall` tool descriptions and rules text mention them. The recalled message comes back as a tool result and is therefore `untrusted`. Summaries without media are unchanged; `manifest: false` turns the new list off as well. The rules text and tool descriptions changed, so the config hash of runs using `compact()` changes too.
