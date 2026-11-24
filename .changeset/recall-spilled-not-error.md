---
"@reinsjs/core": patch
"@reinsjs/brain": patch
---

Wording made consistent about getting folded content back. The default threshold summary no longer says removed events "can be recovered by the host"; it states that they remain in the session log, and the module that provides a recall tool says how to use it (with `compact()`, `recall`). `recall` on a tool result whose output was spilled now returns a normal (non-error) result pointing to the blob and `fetch_blob` "if that tool is in your tool list", so `haltOnFailure` no longer holds back the rest of the batch.
