# @reinsjs/core

## 0.13.0

### Minor Changes

- fba2410: "The outcome is unknown" results now end with the time the call started: ` This call started at <ISO UTC with milliseconds>.`, taken from the call's `core.tool_started` event. With identical parameters, the model can only tell what this call created from an earlier object by its creation time, and it had no anchor for that. The time is added only when the tool is known and not replayable (its `tool_started` is written before `execute`); "may have partly taken effect" and "not executed" texts are unchanged.

  `OUTCOME_UNKNOWN_TEXT` remains an exact prefix of the landed text: compare with `startsWith`, not `===`. New exports: `outcomeUnknownText(tool, at)`, `withStartedAt(text, at)` and `toolStartedAt(timeline)`.

## 0.12.0

### Minor Changes

- e820efb: A paused run can now be resumed from a replay, not only from the stream that saw it pause. The signed resume state is written into the `core.run_paused` event (`payload.state`, model-invisible — the same object as `RunResult.state`), and a replay-only stream whose session ends at that pause carries it in the `end` frame (`state`); with `@reinsjs/ui-agui` it is `RUN_FINISHED.result.state` next to `status: "replayed"`. A page reloaded, reopened or opened on another device can therefore still approve or reject. The state is the one signed at the moment of the pause — never recomputed when read — so configuration drift is still caught. The frame carries the state of the latest pause whatever its reason (approval, budget, abort, stop); decide whether to show an approval card from `state.pendingToolCallIds` and the replayed `core.approval_request` events — after a stop the list is empty. New helper `pausedStateOf(lastEvent)` in `@reinsjs/core` returns the state when the given (last) event is such a pause.

## 0.11.0

### Minor Changes

- b79d193: Add `pullInput` for input that arrives while a run is going. The loop calls it before every model call (not on a turn that only finishes leftover tool calls, not once `maxTurns` is reached) and appends the returned drafts ahead of that turn's socket notes. Only `core.user_message`, `core.system_note` and `ext.*` are accepted; a malformed return value ends the run with `status: "error"` (`core.error` category `input`) and writes none of the batch; a throwing callback is recorded as a model-invisible `core.error` (category `host`) and the run carries on; drafts pulled after an abort are not written. `agent.run()` passes it through. It is per run: `AgentDefinition` (and so `createAgent` options) now omits `pullInput`, so the HTTP handler and `asTool` sub-agents never pull.

## 0.10.0

### Minor Changes

- 45bfc8d: Stop semantics, no replay of interrupted writes, a stop request in the server, and narrower resume validation.

  - **Stop is a kind of abort.** `controller.abort(new RunStop())` makes every pause point close the pending tool calls with an error result ("Not executed: the run was stopped by the user…"; calls that had already started get "outcome unknown" or "interrupted"), so the next run asks the model directly instead of re-running what the user stopped. Approval-pending and client-tool calls are closed too. The result is still `paused` / `host` with the note `stopped by the user`. `new RunStop("host")` is for a host closing calls left by an interrupted run: the same closing, but the texts say an earlier run was interrupted instead of blaming the user (`stopTextsOf`). A run whose signal is already aborted when it starts no longer writes `core.tools_bound` or the tool-change note. Other abort reasons keep the old behaviour (pending calls are replayed on resume). An abort that lands while the request is still connecting now ends as `paused(host)` instead of `error`.
  - **Interrupted writes are not replayed.** New `Tool.replayable` (default: only `risk: "low"` tools) and `isReplayable()`. Non-replayable tools get a model-invisible `core.tool_started` event before `execute`; on resume, a started call without a result is closed with "outcome unknown, check the current state before retrying" instead of running again. A signal-aware write tool cut off by an abort gets the same result instead of "Tool execution failed". Tools that do not declare `risk` now write one extra event per call.
  - **Server stop request.** `POST { sessionId, stop: true }` answers JSON `{ status: "stopping" | "idle", sessionId }` without waiting for the run. `SessionAuthzInput.method` gains `"STOP"` — hooks that allow writes only for `"POST"` will refuse stop requests until they accept `"STOP"`.
  - **`asTool`** declares `replayable: true`, resumes a child only when the parent already recorded `tool_started` for that call (a stopped expert's next task is no longer swallowed), and closes a child's leftover pending calls with `RunStop("host")` before starting a new task.
  - **Narrower resume validation.** `SerializedRunState` gains optional `modelDigest` / `pendingToolsDigest` (included in the signature when present). States carrying them only check the model and the definitions of the tools behind the pending calls, so adding an unrelated tool no longer makes paused sessions answer `409 config_mismatch`; older states still compare the whole configuration hash.
  - Lowerings and the AG-UI encoder declare landings for `core.tool_started` (dropped / `CUSTOM`). The TanStack adapter writes `tool_started` in `onBeforeToolCall` and applies the same no-replay rule; stop handling and resume validation stay out of its scope.

  **Rollback risk:** sessions that contain `core.tool_started` cannot be read by `@reinsjs/core` 0.9 or earlier. Sessions paused inside a sub-agent before upgrading resume the child as a new task after upgrading; let them finish first.

## 0.9.0

### Minor Changes

- 179f891: Video and audio content parts.

  - core: `ContentPart` gains `VideoPart` (`type: "video"`) and `AudioPart` (`type: "audio"`): `mime` must start with `video/` / `audio/`, base64 `data`, optional `durationSec` (finite, positive). `LoweringCapabilities` gains optional `video` / `audio`; absent means the model does not take them. Token estimates follow duration (100 / s for video, 32 / s for audio); without `durationSec` the byte size is converted at 1 Mbps / 64 kbps with a 30-second floor. `isContentPart` checks the new parts and is now also what `runLoop` uses to validate input — which also means `runLoop` input now rejects a `tool_reference` part whose `inputSchema` is an array (tool results already did). A tool returning an array of video / audio-shaped parts now yields media parts instead of JSON text. The budget-truncation summary writes `[video]` / `[audio]` / `[tool <name>]` instead of `[image]` for non-image parts. No `schemaVersion` bump: existing logs read unchanged, but a log containing video or audio parts cannot be read by an older version.
  - lowering-fetch: new `video` / `audio` model options (default `false`, including every built-in model). When on, video and audio travel in each protocol's image slot — a relay dialect official endpoints reject; `input_audio` is deliberately not used. When off, they become placeholder text and the event is `lossy`. Chat lifts video / audio from tool results like images; a result with images only lowers byte-for-byte as before. Fix: `deepseek-v4-pro` is text-only (`images: false`) — the built-in table and `deepseek()` used to claim images, which the provider silently dropped.
  - lowering-pi: video / audio parts become placeholder text (`lossy`); pi-ai has no such content.
  - server: the HTTP whitelist accepts `video` / `audio` parts with the same shape rules as core.
  - adapter-tanstack-ai: data-sourced video / audio parts translate both ways (TanStack has no duration field). URL-sourced parts are now reported in `dropped` as `audio(url)` / `video(url)` instead of `audio` / `video`, and data parts whose mime type does not match their kind as `video(<mime>)` / `audio(<mime>)`. Imported client parts are now checked with core's `isContentPart`: a malformed one (missing `mimeType`, non-string `value`, non-string text) becomes a placeholder reported in `dropped` instead of throwing or reaching the log.
  - ui-agui: video / audio parts become `[video <mime>]` / `[audio <mime>]` placeholders, recorded in `dropped`.
  - tools-mcp: MCP `audio` blocks and `video/*` / `audio/*` embedded resources become audio / video parts instead of descriptions.

## 0.8.0

### Minor Changes

- 54fed37: Sockets can now see the current tool batch. `TurnContext.batch` (`ToolBatch`) lists the batch's tool calls, the results logged so far (in `beforeTool`, only those of earlier calls), the ids left waiting for approval, a client result or a paused sub-agent, and `resumed` when the batch is one a previous run left unfinished. It is one object updated in place during the turn. core also exports `ToolResultEvent` and `toolBatchOf(timeline, pending)`, which locates the batch of leftover calls. **`batch` is a required field**: a host that builds `TurnContext` objects itself (for example in socket unit tests) or runs its own copy of `runLoop` must fill it.

  brain adds two opt-in sockets. `haltOnFailure({ counts?, applies? })` holds back the later calls of a batch once an earlier one failed or is still waiting: each gets an error result naming that call, and nothing runs. Register it first. `stopAfter({ tools })` ends the run (`done`) at the end of a turn in which the model successfully called one of `tools`, when nothing else in the batch failed or is pending. A batch resumed after an approval also ends the run, unless the resumed run brought new user input. Register it after `handoff()` and before `compact()` / `budget()`.

  adapter-tanstack-ai fills `ctx.batch`. Because the engine checks a whole batch before running any of it, `beforeTool` sees no results from the same batch and `held` stays empty. A resumed batch gets no `onTurnEnd` on this path.

## 0.7.0

### Minor Changes

- 2569456: Tool call arguments that the model double-encoded as a JSON string are now unwrapped one level on the read side when the inner value is a plain object (tolerating raw control characters such as unescaped newlines inside string literals), and the `core.tool_call` payload records `meta: { argumentsUnwrapped: true }`. Arguments that do not decode to an object are stored as the original wire text, so `args` is a string only when it is exactly what the model sent; previously the tool could receive a string while the replayed history showed a different value. The Anthropic Messages line no longer replaces a string `content_block_start.input` with `{}`. core adds `decodeToolArgumentsText` / `unwrapToolArguments` / `toolCallArgumentsMeta` and the optional `ToolCallPayload.meta` field.

## 0.6.0

### Minor Changes

- a2ee718: `input` accepts an array of event drafts, appended in order in one write: e.g. a host briefing as `system_note(kind: "host")` followed by the `user_message`, so the model can tell what it is asked to do from what it is told. Every draft passes the type whitelist plus new checks — a valid actor, the basic payload shape of `core.user_message` / `core.tool_result` / `core.system_note` (and of plain content-part arrays), and registration in the registry — so one bad draft rejects the whole batch before anything is written. Previously an unregistered `ext.*` draft or a malformed payload failed only after `tools_bound` (and, on resume, `run_resumed`) had been appended, and a malformed user message could land in the log and break every later run of that session. Content parts cannot be mixed with drafts.

  **Breaking:** the exported `inputDraft(input): EventDraft` is renamed `inputDrafts(input): EventDraft[]` and returns a list.

## 0.5.0

### Minor Changes

- 0455c28: Deliver `compact`'s request as a directive and ask twice. `SystemNotePayload` gains an optional `directive: true` for notes that ask the model to act; `@reinsjs/lowering-fetch` (all three protocols) and `@reinsjs/lowering-pi` send those as a framed `<system_note>` user message even when the model accepts mid-conversation system messages, and record the landing as `lossy(user-role)`. Measured on a pooled DeepSeek relay, the same request was ignored 4 of 4 times as a mid-conversation system message and followed 5 of 6 times as a framed user note; the official DeepSeek endpoint followed it 6 of 6 either way. Other notes (perception, pins) keep their current landing, and notes already in a log keep theirs, so cached prefixes do not change on upgrade. `compact({ force })` now asks at two lines by default (`at: [0.75, 0.8]`; a single number still works), uses blunter wording on the second request (`CompactRequestInfo.attempt`), skips the turn right after a compaction until the model has acted, and marks requests as directives unless `force.directive` is `false`.
- 24ba407: Ask the model to compact before the mechanical fallback kicks in. When the real context passes a soft line (`compact({ force: { at } })`, default `0.75` of the window) and nothing has been compacted since the last request, `compact` appends one runtime note at the end asking the model to call `compact` before doing anything else. A compaction made after such a request is recorded as `decidedBy: "forced"` (new value on `CompactionPayload.decidedBy`: the harness picked the timing, the model wrote the summary). The request is made once per segment; if the model ignores it, threshold truncation still folds mechanically at `contextLimit - reserveTokens`. Appending at the end keeps the prompt cache intact, unlike forcing `tool_choice` or narrowing the tool list. Pass `force: false` to turn it off (the default rules then drop the sentence that promises the request); `force.render` customizes the wording. `@reinsjs/eval` counts the new value separately (`CompactionCounts.forced`). The default `COMPACT_RULES` text gains one line, so sessions paused under an older version see a config change on resume.
- 4a57a7a: Threshold truncation now cuts down to a lower watermark instead of just under the trigger line. Once the context passes `contextLimit - reserveTokens`, `budgetTruncate` removes the oldest turns until the context fits within `contextLimit × cutToRatio` (new option, default `0.6`; values above the trigger line fall back to it). Previously each truncation landed just under the line, so the next tool result pushed it back over: a sliver was cut almost every turn, the prompt cache prefix was invalidated each time, and summaries nested deeper. Pass `defaultProjectionChain({ truncate: { cutToRatio: 1 } })` to restore the old behavior.

## 0.4.0

### Minor Changes

- fb032c1: core: the projection's threshold fallback now compares the calibrated context size — the estimate plus the fixed overhead the estimate cannot see (system prompt, tool definitions, thinking), measured from the last `budget_usage` — against `contextLimit - reserveTokens`. Before, it compared the raw estimate, so perception could report "≥85%, the harness auto-folds at 85%" while no fold happened, and a system prompt plus tool table larger than the reserve could overflow the window before the fallback ever fired. `contextOverheadOf` moves to core (brain still re-exports it) and returns 0 when the last usage record yields a non-finite value, so a malformed `budget_usage` cannot fail the run at start; `ProjectionStats.overheadTokens` is new; `project({ budget: { overheadTokens: 0 } })` restores the old comparison. The fallback now fires earlier by that overhead, and `reserveTokens` is effectively the output reserve.

## 0.3.0

### Minor Changes

- a3afbf9: `SocketSetup.tools` — the tools bound so far when a socket's static contribution is resolved: the host's tools plus those of every socket registered before it, deduplicated (first name wins). `hostTools` is unchanged and still holds only the host's. Each socket now receives its own `SocketSetup` object (shared between its `tools` and `systemPrompt` resolution), so modules that cache "once per setup" keep working. This is what lets `lazyTools()` put tools contributed by earlier sockets — MCP servers — on its menu.

## 0.2.1

### Patch Changes

- Republish of 0.2.0. The 0.2.0 tarballs were uploaded with `npm publish`, which does not rewrite pnpm's `workspace:*` dependency ranges, so every package that depends on `@reinsjs/core` could not be installed (`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` / npm `EUNSUPPORTEDPROTOCOL`). 0.2.1 is the same code published with `pnpm publish`, which writes concrete versions. 0.2.0 is deprecated on npm.

## 0.2.0

### Minor Changes

- 49d5dea: New store interface `RunLease` (`acquire` / `renew` / `release`) and optional `Stores.runLease` — a lease table that lets the "one run per session at a time" guard span processes. Expiry is judged by the store's own clock, `acquire` is idempotent for the same owner, and none of the three methods throw on contention (they answer with a boolean). `InMemoryRunLease({ now })` is the reference implementation (not included in `memoryStore()`, which stays single-process), and `runLeaseConformance` joins the other suites in `@reinsjs/core/testing`.
- 14345eb: Every user-facing runtime string is now English. This covers thrown error messages (construction-time validation, store and registry errors, HTTP 4xx bodies), `warn()` output from the brain modules and the server, the text the model sees in error tool results (`Unknown tool: …`, `Tool call blocked: …`, `Invalid arguments: …`, `Approval denied…`, `Approval expired…`), the `note` / `when` fields of every lowering loss matrix and landing, the placeholder text for content a wire protocol cannot carry, the conformance suites exported from `@reinsjs/core/testing`, and the `@reinsjs/eval` report and gate output. Previously these were Chinese while the READMEs and model-facing prompts were English, which left a non-Chinese-speaking host with unreadable diagnostics.

  Nothing changes structurally: same errors, same codes, same warning points, same landing kinds. Hosts that match on the text of a message or a landing note (rather than on its error code or `landing` value) need to update those matches.

- a082a0c: Deferred tool loading, the provider-native path for `lazyTools()`:

  - `ContentPart` gains a `tool_reference` member — `{ type: "tool_reference", name, description, inputSchema }`, a tool definition carried as content (with a full snapshot, so the log stays self-contained). `renderToolReference(part)` is the one way to render it as text; `normalizeToolOutput` accepts it in tool results.
  - `ToolSpec.deferLoading?: boolean` — a tool that is declared to the provider but not loaded into the model's context until a `tool_reference` to it appears in the history.
  - `LoweringCapabilities.deferredTools: boolean` (required; every lowering must declare it) — whether the wire protocol has a native place for both of the above.
  - `BeforeModelPatch.deferredTools?: string[]` — a socket names which tools of this turn's table are deferred; `runLoop` translates it through the new `deferredToolSpecOf(tool, deferred)`. `toolSpecOf` keeps its single parameter on purpose (it is commonly passed to `map`).

  Projection estimates count a reference as its rendered text. Hosts implementing their own `Lowering` must add `deferredTools: false` to their capabilities.

### Patch Changes

- c16e3ea: README only: point to `@reinsjs/lowering-fetch` as the second lowering layer (the umbrella README's install line and import now show it; `@reinsjs/lowering-pi`'s README links to the side-by-side comparison; `@reinsjs/core`'s module table lists both implementations). No code changes.

## 0.1.1

### Patch Changes

- Docs only: the umbrella package is `@reinsjs/agent` (npm refused the bare name `reins` as too similar to `redis`). READMEs and the 0.1.0 changelog text now say so; no code changes.

## 0.1.0

### Minor Changes

- First public release.

  - **Timeline first.** Append-only event log with `schemaVersion` on every event and fail-closed upcast on read; projection decides what the model sees each turn; replay and fork from the log alone.
  - **A loop you can copy.** `runLoop` as an exported async generator: pause/resume is a return value with a small signed state, bounded retry on transient failures only while nothing has been written, tool pipeline `beforeTool → validate → approval → execute → afterTool`, sub-agent pause bubbling (`Interruption { kind: "subagent" }`).
  - **Tools** can declare `resultTrust` (e.g. `"system"` for host-authored content such as skills); successful results then carry that trust instead of the default `untrusted`, and the lowering layer skips the `<untrusted>` marker. `SkillSource = Pick<MemoryStore, "list" | "read">` names the read-only store subset the brain's `skills()` module consumes.
  - **Brain modules** (`@reinsjs/brain`): perception, compact (with folded-result manifest and `recall`; recommended on after measuring 100% recall at lower token cost on two model families), pins, spill, handoff, memory (`memory_20250818` shape, namespace isolation), approval (deny → ask → allow, fail-closed), budget (five limits, sub-agent usage included), skills (Agent Skills with progressive disclosure: menu in the system prompt, `skill_read` to open one).
  - **Lowering** (`@reinsjs/lowering-pi`): Anthropic Messages and OpenAI Responses via pi-ai with a declared loss matrix, trust markers on untrusted content, cache-breakpoint handling.
  - **Serving** (`@reinsjs/server`, `@reinsjs/ui-agui`): Web-standard handler with SSE replay from `lastSeq`, per-session run lock, `authorizeSession` (only `true` allows), AG-UI as the first-class UI protocol.
  - **Stores**: SQLite (`node:sqlite` / `bun:sqlite`) and Postgres (`pg` / PGlite), conformance-tested; configurable memory table for per-role isolation.
  - **Tools**: MCP servers as one socket (`@reinsjs/tools-mcp`, tools bound per run, annotations as defaults not permissions); `asTool(agent)` in `@reinsjs/agent`.
  - **TanStack AI** middleware (`@reinsjs/adapter-tanstack-ai`): the brain on TanStack's loop with the log as the single source of truth; idempotent client-message import; runtime check for the approval interrupt.
  - **Eval harness** (`@reinsjs/eval`): fixtures from real recordings, recorded tools, arm-vs-arm runner, metrics, the four-rule gate.
