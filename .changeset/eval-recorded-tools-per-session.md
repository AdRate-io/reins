---
"@reinsjs/eval": patch
---

`recordedTools`: replay progress (which of several recordings of the same arguments comes next, and which recordings `sequence: true` has used) is now kept per session. A fixture builds its tools once and every arm and repeat reuses them, so a run that went first used to advance the replay for the runs after it: they got the second recording of a page, or "No recorded response" in sequence mode. A session reached by handoff also starts from the first recording.
