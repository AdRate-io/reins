---
"@reinsjs/brain": patch
---

`handoff()`: an interrupted handoff intent is now rebuilt from the timeline only on the turn that settles the calls left over from a paused run (`ctx.batch.resumed`). Previously any later turn could rebuild it, so after a user stop followed by a new message, a plain-text reply still ended the run with `status: "handoff"`.
