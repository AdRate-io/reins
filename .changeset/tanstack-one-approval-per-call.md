---
"@reinsjs/adapter-tanstack-ai": patch
---

A tool call now raises exactly one approval interrupt. Before, a reins tool declaring `needsApproval: true` (such as an MCP tool with `destructiveHint`) got both TanStack's native approval and `reinsApprovalInterrupt` for the same call: a client answering only the reins one had the resume rejected by the engine and the run ended in an error. Reins tools are now asked only through `reinsApprovalInterrupt`. A host tool with a static `needsApproval: true` that a Socket (such as `approval()`) also wants to ask about is asked only through TanStack's native approval; the `approval_request` records the Socket's policy and summary.
