---
"@reinsjs/agent": minor
---

`createAgent({ store })` installs `leasedRunRegistry(store.runLease)` on the handler when the store provides a `RunLease` (as `pgStores()` now does), so multi-instance deployments get the cross-process "one run per session" guard without extra wiring. A `handler.runs` you pass yourself still wins.
