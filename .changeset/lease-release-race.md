---
"@reinsjs/server": patch
---

`leasedRunRegistry`: a new run on the same session now waits for the previous run's lease release to land before acquiring. Previously a late release could delete the new run's lease, and the next heartbeat aborted it as "lost lease".
