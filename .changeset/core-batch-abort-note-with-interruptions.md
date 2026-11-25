---
"@reinsjs/core": patch
---

A host abort in the middle of a tool batch now always adds the host note to `run_paused`, even when the batch already has another interruption (an approval request, a client tool, a paused sub-agent). The pause reason is unchanged (approval still comes first). Before, such a pause had no note, so `@reinsjs/server` treated the calls after the abort, which were never evaluated, as ready to be filled in, and a client-side tool that needs approval could be answered without approval (`409 call_not_evaluated` now applies as intended).
