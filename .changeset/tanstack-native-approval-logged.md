---
"@reinsjs/adapter-tanstack-ai": patch
---

Answers to TanStack's native approvals (tools with a static `needsApproval: true`) are now logged. Approving one left no `approval_decision` and no `run_resumed`, so the log could not tell who let the call through, and `approval({ ttlMs })` never saw the approval. The middleware now records the answer before the tool phase (`approval_decision` with `by: "tanstack"`, plus one `run_resumed` per run), for answers sent with `resume` and for `approval-responded` parts in `UIMessage`s. Only calls still waiting for approval get a decision.

An approval that carries `editedArgs` different from the arguments the model wrote is no longer executed with the edited arguments: the log keeps the model's call as written, so running other arguments made the timeline disagree with what happened. The call is denied with a second `approval_decision` (`by: "reins"`) whose reason, also shown to the model, names the edited arguments, so the model can make the call again with them.
