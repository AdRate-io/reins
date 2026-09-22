# @reinsjs/core

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
