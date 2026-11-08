# @reinsjs/lowering-fetch

## 0.6.4

### Patch Changes

- Updated dependencies [fba2410]
  - @reinsjs/core@0.13.0

## 0.6.3

### Patch Changes

- Updated dependencies [e820efb]
  - @reinsjs/core@0.12.0

## 0.6.2

### Patch Changes

- Updated dependencies [b79d193]
  - @reinsjs/core@0.11.0

## 0.6.1

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

## 0.6.0

### Minor Changes

- 179f891: Video and audio content parts.

  - core: `ContentPart` gains `VideoPart` (`type: "video"`) and `AudioPart` (`type: "audio"`): `mime` must start with `video/` / `audio/`, base64 `data`, optional `durationSec` (finite, positive). `LoweringCapabilities` gains optional `video` / `audio`; absent means the model does not take them. Token estimates follow duration (100 / s for video, 32 / s for audio); without `durationSec` the byte size is converted at 1 Mbps / 64 kbps with a 30-second floor. `isContentPart` checks the new parts and is now also what `runLoop` uses to validate input — which also means `runLoop` input now rejects a `tool_reference` part whose `inputSchema` is an array (tool results already did). A tool returning an array of video / audio-shaped parts now yields media parts instead of JSON text. The budget-truncation summary writes `[video]` / `[audio]` / `[tool <name>]` instead of `[image]` for non-image parts. No `schemaVersion` bump: existing logs read unchanged, but a log containing video or audio parts cannot be read by an older version.
  - lowering-fetch: new `video` / `audio` model options (default `false`, including every built-in model). When on, video and audio travel in each protocol's image slot — a relay dialect official endpoints reject; `input_audio` is deliberately not used. When off, they become placeholder text and the event is `lossy`. Chat lifts video / audio from tool results like images; a result with images only lowers byte-for-byte as before. Fix: `deepseek-v4-pro` is text-only (`images: false`) — the built-in table and `deepseek()` used to claim images, which the provider silently dropped.
  - lowering-pi: video / audio parts become placeholder text (`lossy`); pi-ai has no such content.
  - server: the HTTP whitelist accepts `video` / `audio` parts with the same shape rules as core.
  - adapter-tanstack-ai: data-sourced video / audio parts translate both ways (TanStack has no duration field). URL-sourced parts are now reported in `dropped` as `audio(url)` / `video(url)` instead of `audio` / `video`, and data parts whose mime type does not match their kind as `video(<mime>)` / `audio(<mime>)`. Imported client parts are now checked with core's `isContentPart`: a malformed one (missing `mimeType`, non-string `value`, non-string text) becomes a placeholder reported in `dropped` instead of throwing or reaching the log.
  - ui-agui: video / audio parts become `[video <mime>]` / `[audio <mime>]` placeholders, recorded in `dropped`.
  - tools-mcp: MCP `audio` blocks and `video/*` / `audio/*` embedded resources become audio / video parts instead of descriptions.

### Patch Changes

- Updated dependencies [179f891]
  - @reinsjs/core@0.9.0

## 0.5.3

### Patch Changes

- Updated dependencies [54fed37]
  - @reinsjs/core@0.8.0

## 0.5.2

### Patch Changes

- 2569456: Tool call arguments that the model double-encoded as a JSON string are now unwrapped one level on the read side when the inner value is a plain object (tolerating raw control characters such as unescaped newlines inside string literals), and the `core.tool_call` payload records `meta: { argumentsUnwrapped: true }`. Arguments that do not decode to an object are stored as the original wire text, so `args` is a string only when it is exactly what the model sent; previously the tool could receive a string while the replayed history showed a different value. The Anthropic Messages line no longer replaces a string `content_block_start.input` with `{}`. core adds `decodeToolArgumentsText` / `unwrapToolArguments` / `toolCallArgumentsMeta` and the optional `ToolCallPayload.meta` field.
- Updated dependencies [2569456]
  - @reinsjs/core@0.7.0

## 0.5.1

### Patch Changes

- Updated dependencies [a2ee718]
  - @reinsjs/core@0.6.0

## 0.5.0

### Minor Changes

- 0455c28: Deliver `compact`'s request as a directive and ask twice. `SystemNotePayload` gains an optional `directive: true` for notes that ask the model to act; `@reinsjs/lowering-fetch` (all three protocols) and `@reinsjs/lowering-pi` send those as a framed `<system_note>` user message even when the model accepts mid-conversation system messages, and record the landing as `lossy(user-role)`. Measured on a pooled DeepSeek relay, the same request was ignored 4 of 4 times as a mid-conversation system message and followed 5 of 6 times as a framed user note; the official DeepSeek endpoint followed it 6 of 6 either way. Other notes (perception, pins) keep their current landing, and notes already in a log keep theirs, so cached prefixes do not change on upgrade. `compact({ force })` now asks at two lines by default (`at: [0.75, 0.8]`; a single number still works), uses blunter wording on the second request (`CompactRequestInfo.attempt`), skips the turn right after a compaction until the model has acted, and marks requests as directives unless `force.directive` is `false`.

### Patch Changes

- Updated dependencies [0455c28]
- Updated dependencies [24ba407]
- Updated dependencies [4a57a7a]
  - @reinsjs/core@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies [fb032c1]
  - @reinsjs/core@0.4.0

## 0.4.0

### Minor Changes

- 90c2120: Chat Completions: images in tool results now reach the model. A `role: "tool"` message carries text only, so when the model takes images (`images: true`, as `deepseek()` declares) each image leaves a pointer in the tool message (`[image n attached in the next user message]`) and the images go into one `user` message right after the whole batch of tool messages, before any user message that was moved after the batch. Each result gets a line naming the tool, the call id and the image count and stating it is tool output, not the user; untrusted results keep their `<untrusted>` marking. The landing is `lossy(tool+lifted-images)`. Set `chat: { liftToolImages: false }` for an upstream that rejects this shape to get the previous placeholder text. The wire shape changes (one more `user` message when tool results carry images); the event log does not.

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

- f3e3427: New package: a zero-dependency lowering layer on `fetch` with a hand-written SSE parser — no provider SDK, no `node:*`, the same `dist/index.js` on Node ≥ 22 and Cloudflare Workers (verified at the strictest workerd tier, 2023 `compatibility_date`, no `nodejs_compat`, each protocol against a live provider). Three wire protocols, each with a declared `LOSS_MATRIX` comparable cell for cell with `@reinsjs/lowering-pi`:

  - **OpenAI Chat Completions** — `deepseek()`, `openaiChat()`, generic `chatCompletions()` for any OpenAI-compatible endpoint. Mid-conversation `system` for `system_note`, deferred user messages recorded `lossy(user)`, thinking `dropped` on the official API and replayed as `reasoning_content` under the DeepSeek dialect (always sent there, because DeepSeek requires the field whenever `tools` is present).
  - **Anthropic Messages** — `anthropic()`, generic `anthropicMessages()`. Mid-conversation `system` placed by the encoder (held until the next assistant turn or the end; framed as user text when the provider's placement rule cannot be met), signed thinking replayed and unsigned thinking `dropped` (declared, never turned into text), three cache breakpoints placed by the layer (system / tools / last user; a trailing note becomes a top-level `cache_control`), `anthropic-beta` only when you set `anthropic.betas`.
  - **OpenAI Responses** — `openai()`, generic `openaiResponses()`. `store: false` forced and `previous_response_id` dropped (the timeline is the only state), `developer` / `system` messages at any position, reasoning items stored whole in `replay.thinkingSignature` and replayed verbatim with `include: ["reasoning.encrypted_content"]` requested by default, `call_id` and the `fc_` item id kept apart.

  `LoweredRequest.payload.body` is exactly the JSON that is POSTed. `auth: "none"` for gateways that carry their own credential header. Non-2xx responses throw `HttpError` (`"<status> <body>"`) so `runLoop`'s retry rule applies unchanged; `timeoutMs` covers the whole stream. The README carries a side-by-side comparison with `@reinsjs/lowering-pi`; both layers stay supported and a timeline written through one replays through the other.

  Responses line: the `phase` of an assistant message item recorded by the stream decoder (`replay.phase`) is now sent back on replay alongside the bare `msg_` id, matching what the `{"v":1,"id","phase"}` signature from `@reinsjs/lowering-pi` already replayed. Loss-matrix notes are joined with `; `.

  All five `examples/` (minimal, mcp, team, adrate, eval) now use this package; the eval gate (PRD §7 threshold 2) was re-run on it for both model families before 0.2.

  Thinking / reasoning replay requires the same provider, API **and model**: a `thinking` signature or an encrypted reasoning item produced by one model is `dropped` (declared in the loss matrix) when the request targets another model of the same provider, instead of being sent and rejected with a 400. Found by re-running the eval gate: the resume fixture's seed history was recorded on one model and replayed to another.

- 14345eb: Every user-facing runtime string is now English. This covers thrown error messages (construction-time validation, store and registry errors, HTTP 4xx bodies), `warn()` output from the brain modules and the server, the text the model sees in error tool results (`Unknown tool: …`, `Tool call blocked: …`, `Invalid arguments: …`, `Approval denied…`, `Approval expired…`), the `note` / `when` fields of every lowering loss matrix and landing, the placeholder text for content a wire protocol cannot carry, the conformance suites exported from `@reinsjs/core/testing`, and the `@reinsjs/eval` report and gate output. Previously these were Chinese while the READMEs and model-facing prompts were English, which left a non-Chinese-speaking host with unreadable diagnostics.

  Nothing changes structurally: same errors, same codes, same warning points, same landing kinds. Hosts that match on the text of a message or a landing note (rather than on its error code or `landing` value) need to update those matches.

- a082a0c: Anthropic Messages line: native deferred tool loading. `ToolSpec.deferLoading` becomes `defer_loading: true` (the cache breakpoint moves to the last non-deferred tool; if every tool would be deferred none is), and a system-trusted `tool_result` made of `tool_reference` parts whose tools are in this request's `tools` is sent as `tool_reference` blocks the API expands in place — the tool list stays identical across the run, so the cache prefix survives a `tool_find` (measured on Haiku 4.5: the next request reads 8.5k cached tokens instead of rewriting them). Text parts of such a result are placed after the batch of `tool_result` blocks and recorded `lossy` / `tool-reference` in the loss matrix; references to tools absent from this request, or inside untrusted results, are rendered as text. New dialect flag `anthropic.deferredTools` and capability `deferredTools` (default on for `provider: "anthropic"`, off for third-party Anthropic-protocol endpoints — DeepSeek's ignores `defer_loading`). Chat Completions and Responses lines render `tool_reference` parts as text and do not send deferred tools.

### Patch Changes

- Updated dependencies [49d5dea]
- Updated dependencies [c16e3ea]
- Updated dependencies [14345eb]
- Updated dependencies [a082a0c]
  - @reinsjs/core@0.2.0
