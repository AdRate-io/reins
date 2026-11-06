---
"@reinsjs/server": patch
---

Mid-run input now works across handlers that share one `runs` registry. A host that builds a handler per request (for example, tools assembled from per-session credentials) previously got `409 run_in_progress` for every mid-run message, because each handler kept its own mailbox table; the mailbox is now found through the shared `runs`, the same way stop requests already work. Both the handler that started the run and the one receiving the message must have `midRunInput: true`; every other rule (same principal, 16 waiting, in-process only) is unchanged.
