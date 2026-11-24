---
"@reinsjs/server": minor
---

`authorizeSession` now receives `decisions`: the approval decisions the request carries, as sent (an empty array for `GET`, `STOP` and requests without any). When the approver is not the session's owner, a host can refuse approvals from anyone else (`decisions.some((d) => d.approved)`) while still allowing refusals, such as a user sending a new message instead of approving. Code that builds a `SessionAuthzInput` itself (test stubs) must add the field. The README also states what was already true: a request with `decisions` but no `resume` is only checked against the pending calls, without the signature or drift checks — always send `resume`.
