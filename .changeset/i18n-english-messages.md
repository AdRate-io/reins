---
"@reinsjs/core": minor
"@reinsjs/brain": minor
"@reinsjs/server": minor
"@reinsjs/lowering-pi": minor
"@reinsjs/lowering-fetch": minor
"@reinsjs/adapter-tanstack-ai": minor
"@reinsjs/store-sqlite": minor
"@reinsjs/store-pg": minor
"@reinsjs/tools-mcp": minor
"@reinsjs/ui-agui": minor
"@reinsjs/eval": minor
"@reinsjs/agent": minor
---

Every user-facing runtime string is now English. This covers thrown error messages (construction-time validation, store and registry errors, HTTP 4xx bodies), `warn()` output from the brain modules and the server, the text the model sees in error tool results (`Unknown tool: …`, `Tool call blocked: …`, `Invalid arguments: …`, `Approval denied…`, `Approval expired…`), the `note` / `when` fields of every lowering loss matrix and landing, the placeholder text for content a wire protocol cannot carry, the conformance suites exported from `@reinsjs/core/testing`, and the `@reinsjs/eval` report and gate output. Previously these were Chinese while the READMEs and model-facing prompts were English, which left a non-Chinese-speaking host with unreadable diagnostics.

Nothing changes structurally: same errors, same codes, same warning points, same landing kinds. Hosts that match on the text of a message or a landing note (rather than on its error code or `landing` value) need to update those matches.
