# @reinsjs/lowering-pi

## 0.4.8

### Patch Changes

- Updated dependencies [fba2410]
  - @reinsjs/core@0.13.0

## 0.4.7

### Patch Changes

- Updated dependencies [e820efb]
  - @reinsjs/core@0.12.0

## 0.4.6

### Patch Changes

- Updated dependencies [b79d193]
  - @reinsjs/core@0.11.0

## 0.4.5

### Patch Changes

- 45bfc8d: Stop semantics, no replay of interrupted writes, a stop request in the server, and narrower resume validation.

  - **Stop is a kind of abort.** `controller.abort(new RunStop())` makes every pause point close the pending tool calls with an error result ("Not executed: the run was stopped by the user…"; calls that had already started get "outcome unknown" or "interrupted"), so the next run asks the model directly instead of re-running what the user stopped. Approval-pending and client-tool calls are closed too. The result is still `paused` / `host` with the note `stopped by the user`. `new RunStop("host")` is for a host closing calls left by an interrupted run: the same closing, but the texts say an earlier run was interrupted instead of blaming the user (`stopTextsOf`). A run whose signal is already aborted when it starts no longer writes `core.tools_bound` or the tool-change note. Other abort reasons keep the old behaviour (pending calls are replayed on resume). An abort that lands while the request is still connecting now ends as `paused(host)` instead of `error`.
  - **Interrupted writes are not replayed.** New `Tool.replayable` (default: only `risk: "low"` tools) and `isReplayable()`. Non-replayable tools get a model-invisible `core.tool_started` event before `execute`; on resume, a started call without a result is closed with "outcome unknown, check the current state before retrying" instead of running again. A signal-aware write tool cut off by an abort gets the same result instead of "Tool execution failed". Tools that do not declare `risk` now write one extra event per call.
  - **Server stop request.** `POST { sessionId, stop: true }` answers JSON `{ status: "stopping" | "idle", sessionId }` without waiting for the run. `SessionAuthzInput.method` gains `"STOP"` — hooks that allow writes only for `"POST"` will refuse stop requests until they accept `"STOP"`.
  - **`asTool`** declares `replayable: true`, resumes a child only when the parent already recorded `tool_started` for that call (a stopped expert's next task is no longer swallowed), and closes a child's leftover pending calls with `RunStop("host")` before starting a new task.
  - **Narrower resume validation.** `SerializedRunState` gains optional `modelDigest` / `pendingToolsDigest` (included in the signature when present). States carrying them only check the model and the definitions of the tools behind the pending calls, so adding an unrelated tool no longer makes paused sessions answer `409 config_mismatch`; older states still compare the whole configuration hash.
  - Lowerings and the AG-UI encoder declare landings for `core.tool_started` (dropped / `CUSTOM`). The TanStack adapter writes `tool_started` in `onBeforeToolCall` and applies the same no-replay rule; stop handling and resume validation stay out of its scope.

  **Rollback risk:** sessions that contain `core.tool_started` cannot be read by `@reinsjs/core` 0.9 or earlier. Sessions paused inside a sub-agent before upgrading resume the child as a new task after upgrading; let them finish first.

- Updated dependencies [45bfc8d]
  - @reinsjs/core@0.10.0

## 0.4.4

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

## 0.4.3

### Patch Changes

- Updated dependencies [54fed37]
  - @reinsjs/core@0.8.0

## 0.4.2

### Patch Changes

- 2569456: Tool call arguments that the model double-encoded as a JSON string are now unwrapped one level on the read side when the inner value is a plain object (tolerating raw control characters such as unescaped newlines inside string literals), and the `core.tool_call` payload records `meta: { argumentsUnwrapped: true }`. Arguments that do not decode to an object are stored as the original wire text, so `args` is a string only when it is exactly what the model sent; previously the tool could receive a string while the replayed history showed a different value. The Anthropic Messages line no longer replaces a string `content_block_start.input` with `{}`. core adds `decodeToolArgumentsText` / `unwrapToolArguments` / `toolCallArgumentsMeta` and the optional `ToolCallPayload.meta` field.
- Updated dependencies [2569456]
  - @reinsjs/core@0.7.0

## 0.4.1

### Patch Changes

- Updated dependencies [a2ee718]
  - @reinsjs/core@0.6.0

## 0.4.0

### Minor Changes

- 0455c28: Deliver `compact`'s request as a directive and ask twice. `SystemNotePayload` gains an optional `directive: true` for notes that ask the model to act; `@reinsjs/lowering-fetch` (all three protocols) and `@reinsjs/lowering-pi` send those as a framed `<system_note>` user message even when the model accepts mid-conversation system messages, and record the landing as `lossy(user-role)`. Measured on a pooled DeepSeek relay, the same request was ignored 4 of 4 times as a mid-conversation system message and followed 5 of 6 times as a framed user note; the official DeepSeek endpoint followed it 6 of 6 either way. Other notes (perception, pins) keep their current landing, and notes already in a log keep theirs, so cached prefixes do not change on upgrade. `compact({ force })` now asks at two lines by default (`at: [0.75, 0.8]`; a single number still works), uses blunter wording on the second request (`CompactRequestInfo.attempt`), skips the turn right after a compaction until the model has acted, and marks requests as directives unless `force.directive` is `false`.

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

- 14345eb: Every user-facing runtime string is now English. This covers thrown error messages (construction-time validation, store and registry errors, HTTP 4xx bodies), `warn()` output from the brain modules and the server, the text the model sees in error tool results (`Unknown tool: …`, `Tool call blocked: …`, `Invalid arguments: …`, `Approval denied…`, `Approval expired…`), the `note` / `when` fields of every lowering loss matrix and landing, the placeholder text for content a wire protocol cannot carry, the conformance suites exported from `@reinsjs/core/testing`, and the `@reinsjs/eval` report and gate output. Previously these were Chinese while the READMEs and model-facing prompts were English, which left a non-Chinese-speaking host with unreadable diagnostics.

  Nothing changes structurally: same errors, same codes, same warning points, same landing kinds. Hosts that match on the text of a message or a landing note (rather than on its error code or `landing` value) need to update those matches.

### Patch Changes

- c16e3ea: README only: point to `@reinsjs/lowering-fetch` as the second lowering layer (the umbrella README's install line and import now show it; `@reinsjs/lowering-pi`'s README links to the side-by-side comparison; `@reinsjs/core`'s module table lists both implementations). No code changes.
- a082a0c: `tool_reference` content parts (new in `@reinsjs/core`) are rendered as text and tools marked `deferLoading` are not sent — pi-ai's request shaping has no place for Anthropic's `defer_loading`; capabilities report `deferredTools: false`.
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
