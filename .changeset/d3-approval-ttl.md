---
"@reinsjs/brain": minor
---

`approval({ ttlMs })` — approvals can now expire. When the host's approval arrives later than `ttlMs` after the `approval_request` (both read from the timeline, not the wall clock), the call is not run: the module appends `approval_decision(approved: false, by: "approval.expired")` and the model receives an error explaining that it may re-issue the call to request a fresh approval. Only calls the policy pipeline would have asked about are affected; calls the policy allows never needed the approval. With the default `rules` text a line about expiry is appended to the system prompt. Unset, behaviour is unchanged.
