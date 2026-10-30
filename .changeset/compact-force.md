---
"@reinsjs/core": minor
"@reinsjs/brain": minor
"@reinsjs/eval": minor
---

Ask the model to compact before the mechanical fallback kicks in. When the real context passes a soft line (`compact({ force: { at } })`, default `0.75` of the window) and nothing has been compacted since the last request, `compact` appends one runtime note at the end asking the model to call `compact` before doing anything else. A compaction made after such a request is recorded as `decidedBy: "forced"` (new value on `CompactionPayload.decidedBy`: the harness picked the timing, the model wrote the summary). The request is made once per segment; if the model ignores it, threshold truncation still folds mechanically at `contextLimit - reserveTokens`. Appending at the end keeps the prompt cache intact, unlike forcing `tool_choice` or narrowing the tool list. Pass `force: false` to turn it off (the default rules then drop the sentence that promises the request); `force.render` customizes the wording. `@reinsjs/eval` counts the new value separately (`CompactionCounts.forced`). The default `COMPACT_RULES` text gains one line, so sessions paused under an older version see a config change on resume.
