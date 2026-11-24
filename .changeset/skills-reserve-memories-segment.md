---
"@reinsjs/brain": minor
---

`skills()`: a `memories` path segment is now reserved for the memory tool. A `root` containing one (such as `/t/memories`) is refused at construction, and any skill key with one — a skill named `memories`, or a supporting file under a `memories/` folder — is skipped from the menu and reads as nonexistent through `skill_read`. Previously a host whose `memory({ namespace })` returned the skills root (or a skill folder) let the model write a file that `skill_read` then returned with system trust.
