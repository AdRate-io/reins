---
"@reinsjs/core": minor
"@reinsjs/agent": minor
"@reinsjs/server": patch
---

Add `pullInput` for input that arrives while a run is going. The loop calls it before every model call (not on a turn that only finishes leftover tool calls, not once `maxTurns` is reached) and appends the returned drafts ahead of that turn's socket notes. Only `core.user_message`, `core.system_note` and `ext.*` are accepted; a malformed return value ends the run with `status: "error"` (`core.error` category `input`) and writes none of the batch; a throwing callback is recorded as a model-invisible `core.error` (category `host`) and the run carries on; drafts pulled after an abort are not written. `agent.run()` passes it through. It is per run: `AgentDefinition` (and so `createAgent` options) now omits `pullInput`, so the HTTP handler and `asTool` sub-agents never pull.
