---
"@reinsjs/core": minor
"@reinsjs/brain": minor
"@reinsjs/lowering-fetch": minor
"@reinsjs/lowering-pi": minor
---

Deliver `compact`'s request as a directive and ask twice. `SystemNotePayload` gains an optional `directive: true` for notes that ask the model to act; `@reinsjs/lowering-fetch` (all three protocols) and `@reinsjs/lowering-pi` send those as a framed `<system_note>` user message even when the model accepts mid-conversation system messages, and record the landing as `lossy(user-role)`. Measured on a pooled DeepSeek relay, the same request was ignored 4 of 4 times as a mid-conversation system message and followed 5 of 6 times as a framed user note; the official DeepSeek endpoint followed it 6 of 6 either way. Other notes (perception, pins) keep their current landing, and notes already in a log keep theirs, so cached prefixes do not change on upgrade. `compact({ force })` now asks at two lines by default (`at: [0.75, 0.8]`; a single number still works), uses blunter wording on the second request (`CompactRequestInfo.attempt`), skips the turn right after a compaction until the model has acted, and marks requests as directives unless `force.directive` is `false`.
