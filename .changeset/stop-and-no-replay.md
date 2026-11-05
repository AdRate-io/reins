---
"@reinsjs/core": minor
"@reinsjs/server": minor
"@reinsjs/agent": minor
"@reinsjs/lowering-fetch": patch
"@reinsjs/lowering-pi": patch
"@reinsjs/ui-agui": patch
"@reinsjs/adapter-tanstack-ai": patch
---

Stop semantics, no replay of interrupted writes, a stop request in the server, and narrower resume validation.

- **Stop is a kind of abort.** `controller.abort(new RunStop())` makes every pause point close the pending tool calls with an error result ("Not executed: the run was stopped by the user…"; calls that had already started get "outcome unknown" or "interrupted"), so the next run asks the model directly instead of re-running what the user stopped. Approval-pending and client-tool calls are closed too. The result is still `paused` / `host` with the note `stopped by the user`. `new RunStop("host")` is for a host closing calls left by an interrupted run: the same closing, but the texts say an earlier run was interrupted instead of blaming the user (`stopTextsOf`). A run whose signal is already aborted when it starts no longer writes `core.tools_bound` or the tool-change note. Other abort reasons keep the old behaviour (pending calls are replayed on resume). An abort that lands while the request is still connecting now ends as `paused(host)` instead of `error`.
- **Interrupted writes are not replayed.** New `Tool.replayable` (default: only `risk: "low"` tools) and `isReplayable()`. Non-replayable tools get a model-invisible `core.tool_started` event before `execute`; on resume, a started call without a result is closed with "outcome unknown, check the current state before retrying" instead of running again. A signal-aware write tool cut off by an abort gets the same result instead of "Tool execution failed". Tools that do not declare `risk` now write one extra event per call.
- **Server stop request.** `POST { sessionId, stop: true }` answers JSON `{ status: "stopping" | "idle", sessionId }` without waiting for the run. `SessionAuthzInput.method` gains `"STOP"` — hooks that allow writes only for `"POST"` will refuse stop requests until they accept `"STOP"`.
- **`asTool`** declares `replayable: true`, resumes a child only when the parent already recorded `tool_started` for that call (a stopped expert's next task is no longer swallowed), and closes a child's leftover pending calls with `RunStop("host")` before starting a new task.
- **Narrower resume validation.** `SerializedRunState` gains optional `modelDigest` / `pendingToolsDigest` (included in the signature when present). States carrying them only check the model and the definitions of the tools behind the pending calls, so adding an unrelated tool no longer makes paused sessions answer `409 config_mismatch`; older states still compare the whole configuration hash.
- Lowerings and the AG-UI encoder declare landings for `core.tool_started` (dropped / `CUSTOM`). The TanStack adapter writes `tool_started` in `onBeforeToolCall` and applies the same no-replay rule; stop handling and resume validation stay out of its scope.

**Rollback risk:** sessions that contain `core.tool_started` cannot be read by `@reinsjs/core` 0.9 or earlier. Sessions paused inside a sub-agent before upgrading resume the child as a new task after upgrading; let them finish first.
