---
"@reinsjs/server": minor
---

`authorizeSession` now receives `decisions`: the approval decisions the request carries, as sent (an empty array for `GET`, `STOP` and requests without any). When the approver is not the session's owner, a host can refuse approvals from anyone else (`decisions.some((d) => d.approved)`) while still allowing refusals, such as a user sending a new message instead of approving. The array is a frozen copy, and it includes entries addressed to sub-agent sessions. Code that builds a `SessionAuthzInput` itself (test stubs) must add the field.

Two related checks close ways around that gate: a request carrying more than one decision for the same call is refused with `400` (the loop would apply the last one, so a hook reading the first could be misled), and a client-side tool result can no longer be filled in while that call is waiting for approval (`409 approval_pending`; send the decision first). The README also states what was already true: a request with `decisions` but no `resume` is only checked against the pending calls, without the signature or drift checks — always send `resume`.
