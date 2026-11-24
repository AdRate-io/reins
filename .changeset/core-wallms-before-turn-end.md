---
"@reinsjs/core": patch
---

`ctx.budget.wallMs` is now refreshed right before `onTurnEnd`, so it includes the time the turn's tool batch took. Before, it was last updated after the model call, so a slow tool batch was only counted after the next model call and a `budget({ limits: { wallMs } })` limit let one extra turn (a model call plus a whole tool batch) run past the limit, with a stale `used` value in the pause note.
