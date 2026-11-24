---
"@reinsjs/brain": patch
---

`handoff()`: an interrupted handoff intent is no longer rebuilt from the timeline once a user message follows the handoff receipt. Previously, after a user stop followed by a new message, a plain-text reply still ended the run with `status: "handoff"`. Rebuilding is not limited to the settling turn, so the TanStack adapter (whose settling batch has no `onTurnEnd`) still honours a handoff scheduled alongside a call that needed approval.
