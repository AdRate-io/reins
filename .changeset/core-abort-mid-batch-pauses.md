---
"@reinsjs/core": patch
---

An abort that lands in the middle of a tool batch now ends the run paused instead of calling `onTurnEnd`. This applies to any abort, such as a dropped connection or a lost lease, not only a user stop. Before, a Socket deciding `handoff` or `stop` in `onTurnEnd` could end the run as `handoff` or `done` while calls from that batch were still pending. What the pause says depends on the abort: a user stop (`RunStop`) closes the pending calls as before, with the note `stopped by the user`; any other abort keeps them pending for the next run, and when nothing else in the batch interrupted the run the pause is `paused(host)` with the note `host aborted during the tool batch`. If the batch also has a call waiting for approval or for a client result, that interruption sets the reason as usual.
