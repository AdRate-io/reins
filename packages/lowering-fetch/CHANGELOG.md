# @reinsjs/lowering-fetch

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
