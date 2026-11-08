---
"@reinsjs/core": minor
"@reinsjs/adapter-tanstack-ai": patch
---

"The outcome is unknown" results now end with the time the call started: ` This call started at <ISO UTC with milliseconds>.`, taken from the call's `core.tool_started` event. With identical parameters, the model can only tell what this call created from an earlier object by its creation time, and it had no anchor for that. The time is added only when the tool is known and not replayable (its `tool_started` is written before `execute`); "may have partly taken effect" and "not executed" texts are unchanged.

`OUTCOME_UNKNOWN_TEXT` remains an exact prefix of the landed text: compare with `startsWith`, not `===`. New exports: `outcomeUnknownText(tool, at)`, `withStartedAt(text, at)` and `toolStartedAt(timeline)`.
