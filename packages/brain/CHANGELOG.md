# @reinsjs/brain

## 0.2.1

### Patch Changes

- Republish of 0.2.0. The 0.2.0 tarballs were uploaded with `npm publish`, which does not rewrite pnpm's `workspace:*` dependency ranges, so every package that depends on `@reinsjs/core` could not be installed (`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` / npm `EUNSUPPORTEDPROTOCOL`). 0.2.1 is the same code published with `pnpm publish`, which writes concrete versions. 0.2.0 is deprecated on npm.
- Updated dependencies
  - @reinsjs/core@0.2.1

## 0.2.0

### Minor Changes

- 19e9820: New module `lazyTools()` — tool discovery for large host tool tables (the consumer of `Tool.lazy`). Host tools marked `lazy: true` appear in the system prompt only as a menu (name + one-line summary); the model loads the ones a task needs with `tool_find({ names })`, which returns their full description and input schema, and from the next turn on those tools are part of the request's tool list. Which tools are loaded is rebuilt from the session timeline (the `tool_find` calls and their non-error results), so pause / resume, later runs on the same session and process restarts all agree; the bound tool table (`tools_bound`, config hash) still holds every tool. Calling a listed-but-unloaded tool is blocked with a message pointing at `tool_find`. Only host tools are affected; tools contributed by other sockets are never hidden. Opt-in: install the socket; with no `lazy` host tool (or a host tool already named `tool_find`) nothing is registered and one warning is emitted.
- bfb49b3: `approval({ ttlMs })` — approvals can now expire. When the host's approval arrives later than `ttlMs` after the `approval_request` (both read from the timeline, not the wall clock), the call is not run: the module appends `approval_decision(approved: false, by: "approval.expired")` and the model receives an error explaining that it may re-issue the call to request a fresh approval. Only calls the policy pipeline would have asked about are affected; calls the policy allows never needed the approval. With the default `rules` text a line about expiry is appended to the system prompt. Unset, behaviour is unchanged.
- 14345eb: Every user-facing runtime string is now English. This covers thrown error messages (construction-time validation, store and registry errors, HTTP 4xx bodies), `warn()` output from the brain modules and the server, the text the model sees in error tool results (`Unknown tool: …`, `Tool call blocked: …`, `Invalid arguments: …`, `Approval denied…`, `Approval expired…`), the `note` / `when` fields of every lowering loss matrix and landing, the placeholder text for content a wire protocol cannot carry, the conformance suites exported from `@reinsjs/core/testing`, and the `@reinsjs/eval` report and gate output. Previously these were Chinese while the READMEs and model-facing prompts were English, which left a non-Chinese-speaking host with unreadable diagnostics.

  Nothing changes structurally: same errors, same codes, same warning points, same landing kinds. Hosts that match on the text of a message or a landing note (rather than on its error code or `landing` value) need to update those matches.

- a082a0c: `lazyTools()` no longer costs a cache rewrite on lowerings that support deferred tools. When `capabilities.deferredTools` is true (`@reinsjs/lowering-fetch` on official Anthropic models) the socket sends the whole tool table on every request and marks the menu tools as deferred, so the tool list never changes; the `tool_find` result now carries one `tool_reference` content part per loaded tool (plus a one-line note and the not-listed names as text) which the provider expands in place. A tool whose loading turn has been compacted out of the current view is sent un-deferred so the model keeps seeing it. On other lowerings the behaviour is unchanged (the tool appears in the next request's list); `renderLoadedTool` now renders the reference through core's `renderToolReference`. Calling a listed-but-unloaded tool is still blocked, on both paths. Public interface of `lazyTools()` unchanged.

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
  - **Brain modules** (`@reinsjs/brain`): perception, compact (with folded-result manifest and `recall`; recommended on after measuring 100% recall at lower token cost on two model families), pins, spill, handoff, memory (`memory_20250818` shape, namespace isolation), approval (deny → ask → allow, fail-closed), budget (five limits, sub-agent usage included), skills (Agent Skills with progressive disclosure: a `SKILL.md` menu in the prompt, `skill_read` to load one on demand; sources are any `MemoryStore`, `inlineSkills`, or `fsSkillSource` from the new `@reinsjs/brain/node` entry).
  - **Lowering** (`@reinsjs/lowering-pi`): Anthropic Messages and OpenAI Responses via pi-ai with a declared loss matrix, trust markers on untrusted content, cache-breakpoint handling.
  - **Serving** (`@reinsjs/server`, `@reinsjs/ui-agui`): Web-standard handler with SSE replay from `lastSeq`, per-session run lock, `authorizeSession` (only `true` allows), AG-UI as the first-class UI protocol.
  - **Stores**: SQLite (`node:sqlite` / `bun:sqlite`) and Postgres (`pg` / PGlite), conformance-tested; configurable memory table for per-role isolation.
  - **Tools**: MCP servers as one socket (`@reinsjs/tools-mcp`, tools bound per run, annotations as defaults not permissions); `asTool(agent)` in `@reinsjs/agent`.
  - **TanStack AI** middleware (`@reinsjs/adapter-tanstack-ai`): the brain on TanStack's loop with the log as the single source of truth; idempotent client-message import; runtime check for the approval interrupt.
  - **Eval harness** (`@reinsjs/eval`): fixtures from real recordings, recorded tools, arm-vs-arm runner, metrics, the four-rule gate.

### Patch Changes

- Updated dependencies
  - @reinsjs/core@0.1.0
