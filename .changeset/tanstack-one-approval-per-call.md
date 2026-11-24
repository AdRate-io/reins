---
"@reinsjs/adapter-tanstack-ai": minor
---

A tool call now raises exactly one approval interrupt, which changes which interrupt a client receives. Before, a reins tool declaring `needsApproval: true` (such as an MCP tool with `destructiveHint`) got both TanStack's native approval and `reinsApprovalInterrupt` for the same call: a client answering only the reins one had the resume rejected by the engine and the run ended in an error.

- Reins tools are now asked only through `reinsApprovalInterrupt`. A client that answered the native `approval_<id>` card for them must answer the reins interrupt instead.
- A host tool with a static `needsApproval: true` that a socket (such as `approval()`) also wants to ask about is asked only through TanStack's native approval; the `approval_request` records the socket's policy and summary. A client that answered the reins interrupt for such a call must answer the native card instead; a `reinsApprovalInterrupt` answer pointing at such a call is ignored with a warning.
