---
"@reinsjs/adapter-tanstack-ai": minor
---

A socket pause now records `code` and `note` in `core.run_paused`, same as the default loop; a pause code that does not match `PAUSE_CODE_RE` is dropped and logged as a non-terminal `core.error` (category `input`), and the run still pauses. Fix: once a turn has already paused the run for an approval or a client tool, `onTurnEnd` is no longer asked — a socket's pause or handoff used to append a second end marker after that `core.run_paused`, hiding what the session was waiting for.
