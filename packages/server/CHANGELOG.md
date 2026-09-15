# @reinsjs/server

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
