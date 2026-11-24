---
"@reinsjs/brain": patch
---

`pins()`: the `pin` tool's "already pinned" check and its `replaces` lookup now only match notes still in effect. Pinning a note back after it was replaced pins it again (instead of answering "Already pinned" while the note would not survive the next compaction), and `replaces` pointing at a note that was already replaced is an error that says so (instead of leaving both the current note and the new one in force).
