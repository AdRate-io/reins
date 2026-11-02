---
"@reinsjs/core": minor
"@reinsjs/brain": minor
"@reinsjs/adapter-tanstack-ai": patch
---

Sockets can now see the current tool batch. `TurnContext.batch` (`ToolBatch`) lists the batch's tool calls, the results logged so far (in `beforeTool`, only those of earlier calls), the ids left waiting for approval, a client result or a paused sub-agent, and `resumed` when the batch is one a previous run left unfinished. It is one object updated in place during the turn. core also exports `ToolResultEvent` and `toolBatchOf(timeline, pending)`, which locates the batch of leftover calls. **`batch` is a required field**: a host that builds `TurnContext` objects itself (for example in socket unit tests) or runs its own copy of `runLoop` must fill it.

brain adds two opt-in sockets. `haltOnFailure({ counts?, applies? })` holds back the later calls of a batch once an earlier one failed or is still waiting: each gets an error result naming that call, and nothing runs. Register it first. `stopAfter({ tools })` ends the run (`done`) at the end of a turn in which the model successfully called one of `tools`, when nothing else in the batch failed or is pending. A batch resumed after an approval also ends the run, unless the resumed run brought new user input. Register it after `handoff()` and before `compact()` / `budget()`.

adapter-tanstack-ai fills `ctx.batch`. Because the engine checks a whole batch before running any of it, `beforeTool` sees no results from the same batch and `held` stays empty. A resumed batch gets no `onTurnEnd` on this path.
