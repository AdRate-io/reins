---
"@reinsjs/core": minor
---

`input` accepts an array of event drafts, appended in order in one write: e.g. a host briefing as `system_note(kind: "host")` followed by the `user_message`, so the model can tell what it is asked to do from what it is told. Every draft passes the type whitelist plus new checks — a valid actor, the basic payload shape of `core.user_message` / `core.tool_result` / `core.system_note` (and of plain content-part arrays), and registration in the registry — so one bad draft rejects the whole batch before anything is written. Previously an unregistered `ext.*` draft or a malformed payload failed only after `tools_bound` (and, on resume, `run_resumed`) had been appended, and a malformed user message could land in the log and break every later run of that session. Content parts cannot be mixed with drafts.

**Breaking:** the exported `inputDraft(input): EventDraft` is renamed `inputDrafts(input): EventDraft[]` and returns a list.
