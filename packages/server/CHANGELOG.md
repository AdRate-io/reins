# @reinsjs/server

## 0.11.0

### Minor Changes

- fddefac: `authorizeSession` now receives `decisions`: the approval decisions the request carries, as sent (an empty array for `GET`, `STOP` and requests without any). When the approver is not the session's owner, a host can refuse approvals from anyone else (`decisions.some((d) => d.approved)`) while still allowing refusals, such as a user sending a new message instead of approving. The array is a frozen copy, and it includes entries addressed to sub-agent sessions. Code that builds a `SessionAuthzInput` itself (test stubs) must add the field.

  Two related checks close ways around that gate: a request carrying more than one decision for the same call is refused with `400` (the loop would apply the last one, so a hook reading the first could be misled), and a client-side tool result can no longer be filled in while that call is waiting for approval (`409 approval_pending`; send the decision first).

  **Breaking for HTTP clients that send `decisions` without `resume`:** such a request is now refused with `400`. Send the state from the pause with the decisions — it is in the `result` frame of the paused run and in the `end` frame of a replay. In-process `runLoop` callers are unaffected.

### Patch Changes

- 62435d5: `leasedRunRegistry`: a new run on the same session now waits for the previous run's lease release to land before acquiring. Previously a late release could delete the new run's lease, and the next heartbeat aborted it as "lost lease".
- 5a88d1b: `nodeListener` now notices a client that disconnects before the handler returns (while it authorizes, reads the log or takes the run lease). The response stream is cancelled as soon as the handler hands it over, so `onDisconnect: "abort"` stops the run and the heartbeat no longer writes to a dead connection. Before, the close listener was attached only after the handler returned, so such an early disconnect was missed and the run went on to the end.
- fde8da4: `nodeListener` (`@reinsjs/server/node`) now catches errors the handler passes up to the host, such as the run lease store being unreachable. Before, such an error was an unhandled rejection, and Node's default is to exit the process, cutting every running run and SSE stream. A thrown `Response` is written back as is; any other error gets `500 { "error": "internal_error" }` (details go to `console.error`, not to the client); a response body that fails mid-stream destroys the connection so the client reconnects and replays. A client that disconnects while still uploading the request body is not reported as an error: the handler is not called and nothing is logged.
- 8a1c005: README: the image route recipe ("Images by reference") now serves only raster formats (PNG, JPEG, GIF, WebP) and sends `x-content-type-options: nosniff` and `content-security-policy: default-src 'none'; sandbox`. The earlier recipe served any `image/*` blob with its stored type, so a session's owner could reference an `image/svg+xml` blob whose scripts would run on your origin with the credentials of whoever opened it, such as an approver. If you copied the recipe, update your route.
- 14b316f: The handler's check of `decisions` now uses the same rule as `runLoop` (`assertDecisionsAwaitApproval`): a decision for this session must point at a call that is waiting for approval, not just at any pending call. Before, approving a pending call that never asked for approval (a client-side tool, or a call later in a batch that was aborted) passed the HTTP check and then failed inside the run, so the client got `200` with an `error` frame instead of `409 unknown_tool_call`. When this check fails while another run of the session is active in this process, the answer is `409 run_in_progress`, as before.
- 0639b3a: An `image` part sent over HTTP (inline or by reference, in an array `input` or in a `core.user_message` / `core.tool_result` draft) must now have a `mime` of `image/jpeg`, `image/png`, `image/gif` or `image/webp`, checked with `isSupportedImageMime` from `@reinsjs/core`; anything else answers `400` and nothing is written. Before, an inline image only needed a string `mime`, so an SVG or a mislabeled file passed the handler and then failed inside the run, giving `200` with an `error` frame instead of `400`.
- 7ac3586: The handler's resume pre-check now resolves Socket contributions with the request's `principal`, the same input the run itself starts with. A Socket that picks its tools from `setup.principal` no longer makes a legitimate resume fail with `409 config_mismatch` ("the definition of pending tool … differs"), and a client-side tool result for such a tool is no longer refused as a server-side tool.
- 3d15ec1: A client-side tool result is no longer accepted for a call the loop never evaluated. When a run is aborted by the host (a dropped connection with `onDisconnect: "abort"`, a lost lease) partway through a tool batch, the calls after the abort stay pending without ever reaching `beforeTool` or the approval check, so a client could fill in the result of a call that needs approval and skip both the approval and the approver's `authorizeSession` check. Filling in is now accepted only when the session's last run paused for external answers alone (no budget / host note, not a stop); otherwise the handler answers `409 call_not_evaluated`, and a `POST { sessionId }` without `input` lets the run evaluate the pending calls again before the result is sent.
- Updated dependencies [729f892]
- Updated dependencies [e04c188]
- Updated dependencies [3830f23]
- Updated dependencies [60b6052]
- Updated dependencies [9856645]
- Updated dependencies [b4de7f3]
- Updated dependencies [4a2f5b6]
- Updated dependencies [6eb8b09]
- Updated dependencies [cf87a07]
- Updated dependencies [53c5561]
- Updated dependencies [afcc7b7]
- Updated dependencies [040768e]
- Updated dependencies [5703a3e]
- Updated dependencies [da6250a]
- Updated dependencies [6cd00cd]
- Updated dependencies [b086f75]
- Updated dependencies [7e4f674]
- Updated dependencies [9291394]
- Updated dependencies [9d47f4d]
- Updated dependencies [01b9440]
- Updated dependencies [7a7fbe4]
- Updated dependencies [1c6fc8c]
- Updated dependencies [246c457]
- Updated dependencies [252764c]
- Updated dependencies [bdfdc7c]
- Updated dependencies [5c36bfd]
  - @reinsjs/core@0.18.0

## 0.10.0

### Minor Changes

- 420e0f7: The image-reference pre-check reads metadata only: it calls `BlobStore.stat` when the store has one (falling back to `get`), so a message with N new images reads their bytes N times instead of 2N. With `midRunInput` on, a message that falls back from queuing to starting a run is no longer checked twice. If your `stat` disagrees with `get`, the loop's check (by `get`) wins and the request ends in `200` with an `error` frame instead of `400`.

### Patch Changes

- Updated dependencies [420e0f7]
  - @reinsjs/core@0.17.0

## 0.9.0

### Minor Changes

- c47e62b: `input` may carry image references (`{ type: "image", mime, blobId }`). The handler checks them with core's `checkImageRefs` before it queues a message during a run or starts a run: a reference to a missing blob, another session's blob, a blob with a different `mime`, or with no `BlobStore` gets `400` (`Blob <id> not found in this session`) and nothing is written; a storage error while checking gets `503 storage_unavailable`. The README shows how to serve the image bytes from your own route with `blobUsableBy`.

### Patch Changes

- Updated dependencies [c47e62b]
- Updated dependencies [12d9343]
  - @reinsjs/core@0.16.0

## 0.8.2

### Patch Changes

- Updated dependencies [f8a3550]
  - @reinsjs/core@0.15.0

## 0.8.1

### Patch Changes

- Updated dependencies [831a50a]
  - @reinsjs/core@0.14.1

## 0.8.0

### Minor Changes

- 884c840: Session run status. Every `runLoop` run now starts with `core.tools_bound` (carrying `marksEnd: true`) and ends with exactly one end marker: `core.run_paused` as before, or the new model-invisible `core.run_ended` with `status: "done" | "handoff" | "error"`. `core.run_paused` gains `awaiting` (the pending calls waiting on an approval — with `requestedAt` —, a client tool or a sub-agent) and `stopped: true` for a user stop. A `core.error` the loop retries past, or one recorded for a throwing `pullInput`, gets no `run_ended`; an error that ends the run is written together with its `run_ended`.

  `runStatusOf({ held, lastMarker })` classifies a session as running / paused / done / handoff / error / interrupted / idle / unknown from a lease flag and `lastRunMarker(timeline)`. `@reinsjs/store-pg` adds `pgRunStates(client, sessionIds)`: one SQL statement reads the leases and each session's last marker, so a session list never sees a gap between "lease released" and "outcome written". "Running" is only known for runs started through the server handler with a lease registry (`createAgent` + `pgStores`).

  Log shape changes: on a resumed run `core.tools_bound` now comes before `core.run_resumed` / `core.approval_decision`, and `RunResult.lastSeq` of a done or handoff run points at its `run_ended`. Live streams carry one more event (a `CUSTOM` frame in AG-UI). The TanStack adapter writes `run_ended` too, but its `tools_bound` carries no `marksEnd` and its `run_paused` no `awaiting` / `stopped`. Lowerings drop `run_ended` like other operational events.

  **Rolling upgrade:** `@reinsjs/core` 0.13 and earlier reject sessions that contain `core.run_ended` (unknown event type). Upgrade every instance to the same core version at once, and do not roll back past 0.14 once such sessions exist. Sessions whose last run finished before the upgrade read `unknown`.

### Patch Changes

- Updated dependencies [884c840]
  - @reinsjs/core@0.14.0

## 0.7.2

### Patch Changes

- Updated dependencies [fba2410]
  - @reinsjs/core@0.13.0

## 0.7.1

### Patch Changes

- cb77214: Fix: when a single model response streamed both thinking and text, the live AG-UI stream sent each of them twice — once from the deltas (ended without `metadata.reins`) and again in full when the timeline events were committed. Every lowering hands over its drafts only after the whole response has streamed, so the encoder now keeps every streamed block open until a committed `core.model_thinking` / `core.model_text` whose text matches the streamed text claims it, and ends it with `metadata.reins`. Each streamed segment now has exactly one `_START` / `_CONTENT…` / `_END`, and a thinking block and a text block may be open at the same time (AG-UI tracks messages by id; all are ended before `RUN_FINISHED`). A committed event that matches no streamed block (for example the redacted-thinking placeholder) is sent in full as before; blocks no event claims are ended, without metadata, before any non-model event and at the end of the run.

  `@reinsjs/server`: a stream that attaches to a run already in progress (`GET`) now skips deltas until the next event signal. Before, it forwarded the rest of the block being streamed at that moment, so the client got a block missing its first half.

## 0.7.0

### Minor Changes

- e820efb: A paused run can now be resumed from a replay, not only from the stream that saw it pause. The signed resume state is written into the `core.run_paused` event (`payload.state`, model-invisible — the same object as `RunResult.state`), and a replay-only stream whose session ends at that pause carries it in the `end` frame (`state`); with `@reinsjs/ui-agui` it is `RUN_FINISHED.result.state` next to `status: "replayed"`. A page reloaded, reopened or opened on another device can therefore still approve or reject. The state is the one signed at the moment of the pause — never recomputed when read — so configuration drift is still caught. The frame carries the state of the latest pause whatever its reason (approval, budget, abort, stop); decide whether to show an approval card from `state.pendingToolCallIds` and the replayed `core.approval_request` events — after a stop the list is empty. New helper `pausedStateOf(lastEvent)` in `@reinsjs/core` returns the state when the given (last) event is such a pause.

### Patch Changes

- Updated dependencies [e820efb]
  - @reinsjs/core@0.12.0

## 0.6.1

### Patch Changes

- 61eacbb: Mid-run input now works across handlers that share one `runs` registry. A host that builds a handler per request (for example, tools assembled from per-session credentials) previously got `409 run_in_progress` for every mid-run message, because each handler kept its own mailbox table; the mailbox is now found through the shared `runs`, the same way stop requests already work. Both the handler that started the run and the one receiving the message must have `midRunInput: true`; every other rule (same principal, 16 waiting, in-process only) is unchanged.

## 0.6.0

### Minor Changes

- 720a809: HTTP mid-run input. `createAgentHandler(agent, { midRunInput: true })` queues a user message that arrives while the session's run is active in this process — sent by the run's own principal, without `resume` / `decisions` — into a per-run in-memory mailbox and answers `202 { status: "queued", sessionId, deliveryId }`; the run writes it into the timeline before its next model call. New request field `deliveryId` (also accepted when a `POST` starts a run) becomes the message's `provenance.ref` with `source: USER_DELIVERY_SOURCE`; delivery is judged by that event appearing in the timeline. Undelivered messages are dropped when the run ends; other cases still answer `409`, a full mailbox (16 waiting) answers `429 mailbox_full`. `@reinsjs/ui-agui` now copies a user message's `provenance` onto its `TEXT_MESSAGE_START` as `metadata.reins.provenance`; other events are unchanged.

## 0.5.1

### Patch Changes

- b79d193: Add `pullInput` for input that arrives while a run is going. The loop calls it before every model call (not on a turn that only finishes leftover tool calls, not once `maxTurns` is reached) and appends the returned drafts ahead of that turn's socket notes. Only `core.user_message`, `core.system_note` and `ext.*` are accepted; a malformed return value ends the run with `status: "error"` (`core.error` category `input`) and writes none of the batch; a throwing callback is recorded as a model-invisible `core.error` (category `host`) and the run carries on; drafts pulled after an abort are not written. `agent.run()` passes it through. It is per run: `AgentDefinition` (and so `createAgent` options) now omits `pullInput`, so the HTTP handler and `asTool` sub-agents never pull.
- Updated dependencies [b79d193]
  - @reinsjs/core@0.11.0

## 0.5.0

### Minor Changes

- 45bfc8d: Stop semantics, no replay of interrupted writes, a stop request in the server, and narrower resume validation.

  - **Stop is a kind of abort.** `controller.abort(new RunStop())` makes every pause point close the pending tool calls with an error result ("Not executed: the run was stopped by the user…"; calls that had already started get "outcome unknown" or "interrupted"), so the next run asks the model directly instead of re-running what the user stopped. Approval-pending and client-tool calls are closed too. The result is still `paused` / `host` with the note `stopped by the user`. `new RunStop("host")` is for a host closing calls left by an interrupted run: the same closing, but the texts say an earlier run was interrupted instead of blaming the user (`stopTextsOf`). A run whose signal is already aborted when it starts no longer writes `core.tools_bound` or the tool-change note. Other abort reasons keep the old behaviour (pending calls are replayed on resume). An abort that lands while the request is still connecting now ends as `paused(host)` instead of `error`.
  - **Interrupted writes are not replayed.** New `Tool.replayable` (default: only `risk: "low"` tools) and `isReplayable()`. Non-replayable tools get a model-invisible `core.tool_started` event before `execute`; on resume, a started call without a result is closed with "outcome unknown, check the current state before retrying" instead of running again. A signal-aware write tool cut off by an abort gets the same result instead of "Tool execution failed". Tools that do not declare `risk` now write one extra event per call.
  - **Server stop request.** `POST { sessionId, stop: true }` answers JSON `{ status: "stopping" | "idle", sessionId }` without waiting for the run. `SessionAuthzInput.method` gains `"STOP"` — hooks that allow writes only for `"POST"` will refuse stop requests until they accept `"STOP"`.
  - **`asTool`** declares `replayable: true`, resumes a child only when the parent already recorded `tool_started` for that call (a stopped expert's next task is no longer swallowed), and closes a child's leftover pending calls with `RunStop("host")` before starting a new task.
  - **Narrower resume validation.** `SerializedRunState` gains optional `modelDigest` / `pendingToolsDigest` (included in the signature when present). States carrying them only check the model and the definitions of the tools behind the pending calls, so adding an unrelated tool no longer makes paused sessions answer `409 config_mismatch`; older states still compare the whole configuration hash.
  - Lowerings and the AG-UI encoder declare landings for `core.tool_started` (dropped / `CUSTOM`). The TanStack adapter writes `tool_started` in `onBeforeToolCall` and applies the same no-replay rule; stop handling and resume validation stay out of its scope.

  **Rollback risk:** sessions that contain `core.tool_started` cannot be read by `@reinsjs/core` 0.9 or earlier. Sessions paused inside a sub-agent before upgrading resume the child as a new task after upgrading; let them finish first.

### Patch Changes

- Updated dependencies [45bfc8d]
  - @reinsjs/core@0.10.0

## 0.4.3

### Patch Changes

- 179f891: Video and audio content parts.

  - core: `ContentPart` gains `VideoPart` (`type: "video"`) and `AudioPart` (`type: "audio"`): `mime` must start with `video/` / `audio/`, base64 `data`, optional `durationSec` (finite, positive). `LoweringCapabilities` gains optional `video` / `audio`; absent means the model does not take them. Token estimates follow duration (100 / s for video, 32 / s for audio); without `durationSec` the byte size is converted at 1 Mbps / 64 kbps with a 30-second floor. `isContentPart` checks the new parts and is now also what `runLoop` uses to validate input — which also means `runLoop` input now rejects a `tool_reference` part whose `inputSchema` is an array (tool results already did). A tool returning an array of video / audio-shaped parts now yields media parts instead of JSON text. The budget-truncation summary writes `[video]` / `[audio]` / `[tool <name>]` instead of `[image]` for non-image parts. No `schemaVersion` bump: existing logs read unchanged, but a log containing video or audio parts cannot be read by an older version.
  - lowering-fetch: new `video` / `audio` model options (default `false`, including every built-in model). When on, video and audio travel in each protocol's image slot — a relay dialect official endpoints reject; `input_audio` is deliberately not used. When off, they become placeholder text and the event is `lossy`. Chat lifts video / audio from tool results like images; a result with images only lowers byte-for-byte as before. Fix: `deepseek-v4-pro` is text-only (`images: false`) — the built-in table and `deepseek()` used to claim images, which the provider silently dropped.
  - lowering-pi: video / audio parts become placeholder text (`lossy`); pi-ai has no such content.
  - server: the HTTP whitelist accepts `video` / `audio` parts with the same shape rules as core.
  - adapter-tanstack-ai: data-sourced video / audio parts translate both ways (TanStack has no duration field). URL-sourced parts are now reported in `dropped` as `audio(url)` / `video(url)` instead of `audio` / `video`, and data parts whose mime type does not match their kind as `video(<mime>)` / `audio(<mime>)`. Imported client parts are now checked with core's `isContentPart`: a malformed one (missing `mimeType`, non-string `value`, non-string text) becomes a placeholder reported in `dropped` instead of throwing or reaching the log.
  - ui-agui: video / audio parts become `[video <mime>]` / `[audio <mime>]` placeholders, recorded in `dropped`.
  - tools-mcp: MCP `audio` blocks and `video/*` / `audio/*` embedded resources become audio / video parts instead of descriptions.

- Updated dependencies [179f891]
  - @reinsjs/core@0.9.0

## 0.4.2

### Patch Changes

- Updated dependencies [54fed37]
  - @reinsjs/core@0.8.0

## 0.4.1

### Patch Changes

- Updated dependencies [2569456]
  - @reinsjs/core@0.7.0

## 0.4.0

### Minor Changes

- a2ee718: An array `input` in a `POST` body must now be a non-empty list of `text` / `image` parts, checked on every request (also those without `resume` / `decisions`). Requests that are now refused with `400`: empty arrays, arrays containing `tool_reference` parts, malformed parts, and arrays of event drafts. Content parts — in arrays and inside `user_message` / `tool_result` drafts — are rebuilt from their known fields, so extra fields never reach the loop.

### Patch Changes

- Updated dependencies [a2ee718]
  - @reinsjs/core@0.6.0

## 0.3.2

### Patch Changes

- Updated dependencies [0455c28]
- Updated dependencies [24ba407]
- Updated dependencies [4a57a7a]
  - @reinsjs/core@0.5.0

## 0.3.1

### Patch Changes

- Updated dependencies [fb032c1]
  - @reinsjs/core@0.4.0

## 0.3.0

### Minor Changes

- Version alignment: every `@reinsjs/*` package ships as 0.3.0 together with `@reinsjs/core` and `@reinsjs/brain` (MCP tools on the `lazyTools()` menu via `SocketSetup.tools`). No behaviour change in these packages beyond the dependency bump.

### Patch Changes

- Updated dependencies [a3afbf9]
  - @reinsjs/core@0.3.0

## 0.2.1

### Patch Changes

- Republish of 0.2.0. The 0.2.0 tarballs were uploaded with `npm publish`, which does not rewrite pnpm's `workspace:*` dependency ranges, so every package that depends on `@reinsjs/core` could not be installed (`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` / npm `EUNSUPPORTEDPROTOCOL`). 0.2.1 is the same code published with `pnpm publish`, which writes concrete versions. 0.2.0 is deprecated on npm.
- Updated dependencies
  - @reinsjs/core@0.2.1

## 0.2.0

### Minor Changes

- 5955d45: New handler option `onEvent(event, { sessionId, principal, request })` — a side-channel observer for runs started over HTTP. It is called once per event the run appends, in `seq` order, with the resolved `principal` and the originating `Request`, so hosts can attach trace ids and user ids to their own logs. It observes and does not edit; only live events are reported (replays are read back from the log and skipped); the run is never slowed or broken by it — events reach SSE subscribers first, async return values are chained in order without blocking the loop, and a failure is reported once per run through the new `warn` option (default `console.warn`). The run's `result` frame and `ActiveRun.done` wait for the chain to settle so a Worker's `waitUntil` covers the last observation. In-process, `agent.run()` is already an async generator of events and needs no hook.
- 49d5dea: `RunRegistry` is now an interface (`get(sessionId)`, `create(sessionId, controller?): Promise<ActiveRun>`); the previous class is renamed `InMemoryRunRegistry` and stays the default. New `leasedRunRegistry(lease, { ttlMs = 30_000, owner, warn })` wraps it with a `RunLease` from the store so a second `POST` on a session that is running on _another_ instance answers `409 run_in_progress` instead of wasting a model call: the lease is acquired before the run starts, renewed every `ttlMs / 3`, and released when the run ends; a lost lease aborts the run into `paused(host)`; failed renewals and releases only warn. `GET` still joins runs of this process only. `ActiveRun` gains `onFinish(fn)`; `done` now resolves after those hooks settle so a Worker's `waitUntil` covers the release. Breaking for custom registries and direct callers: `create` is async.
- 14345eb: Every user-facing runtime string is now English. This covers thrown error messages (construction-time validation, store and registry errors, HTTP 4xx bodies), `warn()` output from the brain modules and the server, the text the model sees in error tool results (`Unknown tool: …`, `Tool call blocked: …`, `Invalid arguments: …`, `Approval denied…`, `Approval expired…`), the `note` / `when` fields of every lowering loss matrix and landing, the placeholder text for content a wire protocol cannot carry, the conformance suites exported from `@reinsjs/core/testing`, and the `@reinsjs/eval` report and gate output. Previously these were Chinese while the READMEs and model-facing prompts were English, which left a non-Chinese-speaking host with unreadable diagnostics.

  Nothing changes structurally: same errors, same codes, same warning points, same landing kinds. Hosts that match on the text of a message or a landing note (rather than on its error code or `landing` value) need to update those matches.

### Patch Changes

- Updated dependencies [49d5dea]
- Updated dependencies [c16e3ea]
- Updated dependencies [14345eb]
- Updated dependencies [a082a0c]
  - @reinsjs/core@0.2.0

## 0.1.1

### Patch Changes

- Docs only: the umbrella package is `@reinsjs/agent` (npm refused the bare name `reins` as too similar to `redis`). READMEs and the 0.1.0 changelog text now say so; no code changes.
- Updated dependencies
  - @reinsjs/core@0.1.1

## 0.1.0

### Minor Changes

- First public release.

  - **Timeline first.** Append-only event log with `schemaVersion` on every event and fail-closed upcast on read; projection decides what the model sees each turn; replay and fork from the log alone.
  - **A loop you can copy.** `runLoop` as an exported async generator: pause/resume is a return value with a small signed state, bounded retry on transient failures only while nothing has been written, tool pipeline `beforeTool → validate → approval → execute → afterTool`, sub-agent pause bubbling (`Interruption { kind: "subagent" }`).
  - **Brain modules** (`@reinsjs/brain`): perception, compact (with folded-result manifest and `recall`; recommended on after measuring 100% recall at lower token cost on two model families), pins, spill, handoff, memory (`memory_20250818` shape, namespace isolation), approval (deny → ask → allow, fail-closed), budget (five limits, sub-agent usage included), skills (Agent Skills with progressive disclosure: menu in the system prompt, `skill_read` to open one).
  - **Lowering** (`@reinsjs/lowering-pi`): Anthropic Messages and OpenAI Responses via pi-ai with a declared loss matrix, trust markers on untrusted content, cache-breakpoint handling.
  - **Serving** (`@reinsjs/server`, `@reinsjs/ui-agui`): Web-standard handler with SSE replay from `lastSeq`, per-session run lock, `authorizeSession` (only `true` allows), AG-UI as the first-class UI protocol.
  - **Stores**: SQLite (`node:sqlite` / `bun:sqlite`) and Postgres (`pg` / PGlite), conformance-tested; configurable memory table for per-role isolation.
  - **Tools**: MCP servers as one socket (`@reinsjs/tools-mcp`, tools bound per run, annotations as defaults not permissions); `asTool(agent)` in `@reinsjs/agent`.
  - **TanStack AI** middleware (`@reinsjs/adapter-tanstack-ai`): the brain on TanStack's loop with the log as the single source of truth; idempotent client-message import; runtime check for the approval interrupt.
  - **Eval harness** (`@reinsjs/eval`): fixtures from real recordings, recorded tools, arm-vs-arm runner, metrics, the four-rule gate.

### Patch Changes

- Updated dependencies
  - @reinsjs/core@0.1.0
