# @reinsjs/eval

## 0.4.0

### Minor Changes

- 24ba407: Ask the model to compact before the mechanical fallback kicks in. When the real context passes a soft line (`compact({ force: { at } })`, default `0.75` of the window) and nothing has been compacted since the last request, `compact` appends one runtime note at the end asking the model to call `compact` before doing anything else. A compaction made after such a request is recorded as `decidedBy: "forced"` (new value on `CompactionPayload.decidedBy`: the harness picked the timing, the model wrote the summary). The request is made once per segment; if the model ignores it, threshold truncation still folds mechanically at `contextLimit - reserveTokens`. Appending at the end keeps the prompt cache intact, unlike forcing `tool_choice` or narrowing the tool list. Pass `force: false` to turn it off (the default rules then drop the sentence that promises the request); `force.render` customizes the wording. `@reinsjs/eval` counts the new value separately (`CompactionCounts.forced`). The default `COMPACT_RULES` text gains one line, so sessions paused under an older version see a config change on resume.

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
