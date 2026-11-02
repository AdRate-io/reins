---
"@reinsjs/core": minor
---

`input` accepts an array of event drafts, appended in order in one write: e.g. a host briefing as `system_note(kind: "host")` followed by the `user_message`, so the model can tell what it is asked to do from what it is told. Every draft passes the same type whitelist and now an actor check; one bad draft rejects the whole batch before anything is written; content parts cannot be mixed with drafts.

**Breaking:** the exported `inputDraft(input): EventDraft` is renamed `inputDrafts(input): EventDraft[]` and returns a list.
