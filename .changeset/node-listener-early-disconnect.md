---
"@reinsjs/server": patch
---

`nodeListener` now notices a client that disconnects before the handler returns (while it authorizes, reads the log or takes the run lease). The response stream is cancelled as soon as the handler hands it over, so `onDisconnect: "abort"` stops the run and the heartbeat no longer writes to a dead connection. Before, the close listener was attached only after the handler returned, so such an early disconnect was missed and the run went on to the end.
