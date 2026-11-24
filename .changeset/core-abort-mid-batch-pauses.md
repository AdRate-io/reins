---
"@reinsjs/core": patch
---

An abort that lands in the middle of a tool batch now always ends the run as `paused(host)` ("host aborted during the tool batch") without calling `onTurnEnd`. This applies to any abort, such as a dropped connection or a lost lease, not only a user stop. Before, a Socket deciding `handoff` or `stop` in `onTurnEnd` could end the run as `handoff` or `done` while calls from that batch were still pending. Those calls are still kept pending and run on the next resume, as before.
