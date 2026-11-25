# @reinsjs/brain

## 0.11.0

### Minor Changes

- 90f5bd2: Modules that bring their own tools — `compact()` (`compact`, `recall`), `spill()` (`fetch_blob`), `pins()` (`pin`), `handoff()`, `memory()`, `skills()` (`skill_read`) and `lazyTools()` (`tool_find`) — now stand down when a tool of the same name is already bound before them (a host tool, or one from a socket registered earlier such as an MCP server). The loop keeps the first tool of a name, so before this the module's rules sent the model to someone else's tool and its hooks treated that tool's calls as its own: a spilled result fetched from an MCP server, an MCP `handoff` call ending the session, an MCP `compact` call folding history. Now the module registers neither its tools nor its rules for that run, its hooks stay idle, and it warns once. `spill()` then passes results through unspilled, as without a `BlobStore`; `pins()` keeps the host's pins and drops only the `pin` tool, as with `tool: false`. Passing the module's own tool object in the host's `tools` is not a clash. `compact()`, `pins()` and `handoff()` gain a `warn` option for this. Because the check needs the tool table, these modules' `tools` and `systemPrompt` contributions are now functions of the socket setup: code that read `spill().systemPrompt` or `handoff().tools` as plain values should resolve them with `resolveSocketContributions` from `@reinsjs/core`.
- ff0a333: `compact({ recall: false })`: the default rules, the `compact` tool description and the manifest headings no longer tell the model to use `recall({ seq })`, which it does not have; the manifest is still listed, headed "still in the session log, by seq". New exports `compactToolDescription(recall)`, `COMPACT_RECALL_RULE`, `COMPACT_NO_RECALL_RULE`, `MANIFEST_HEADING_NO_RECALL` and `MEDIA_MANIFEST_HEADING_NO_RECALL`; `renderCompactionSummary` and `planCompaction` take an optional `recall` flag (default `true`, output unchanged).
- 984548c: `memory()`: the value returned by `namespace(ctx)` is now validated before every call. It must be `""` or a canonical path (leading `/`, no trailing `/`, no empty, `.`, `..` or `memories` segments); otherwise the call fails with `isError`, touches no keys, and `warn` reports the first invalid value once per `memory()` instance. Previously any string was used as-is, so prefixes such as `/a` and `/a/memories/x` could nest and let one principal read and write the other's memories.
- 72902cd: `skills()`: a `memories` path segment is now reserved for the memory tool. A `root` containing one (such as `/t/memories`) is refused at construction, and any skill key with one — a skill named `memories`, or a supporting file under a `memories/` folder — is skipped from the menu and reads as nonexistent through `skill_read`. Previously a host whose `memory({ namespace })` returned the skills root (or a skill folder) let the model write a file that `skill_read` then returned with system trust.

### Patch Changes

- 70f2247: `approval()`: a rule's `summary()` that throws is now treated like a throwing `match()` — the call is denied (fail-closed) with the rule id as `by`, instead of the error escaping `runLoop` and leaving the call pending for every later run.
- fa0e6c9: Copies of a module's own tools are no longer mistaken for someone else's. Modules that bring their own tools (`compact()`, `spill()`, `pins()`, `handoff()`, `memory()`, `skills()`, `lazyTools()`) recognised them by object identity, so a `beforeModel` patch that copies the tool table (for example `ctx.tools.map((t) => ({ ...t }))` to reword descriptions) silently switched them off: `spill()` stopped spilling, `handoff()` no longer ended the run, `lazyTools()` sent every lazy tool in full, all without a warning. A host that put a copy of a module's tool in its own `tools` was also treated as a name clash. A tool now counts as the module's own when it is the same object, or has the same name and the same `execute` function; a same-name tool with a different or wrapped `execute` still does not.
- bda7466: The default `budget()` pause note no longer promises a fresh budget for `contextTokens`. That limit is the size of the latest model request, and a resumed run inherits it from the log, so resuming does not reset it. Each turn is checked against the request that turn made, before any compaction in it takes effect, so a resumed run pauses at least once more, and the limit clears only once a later request is smaller (after the model compacts, or the session hands off). The note now says so when `contextTokens` is among the hit limits, and still says resuming starts a fresh budget for `totalTokens`, `turns`, `toolCalls` and `wallMs`. The README and the `BudgetLimits.contextTokens` docs say the same.
- 1c6fc8c: The folded-results list, `recall`'s answer for a spilled result and the `recall` tool description now say the same thing about spilled outputs: read them with `fetch_blob` "if that tool is in your tool list". The list used to state it unconditionally, though a run may not have `fetch_blob` (`spill({ tool: false })`, or spill removed later).
- ac5e3ad: `handoff()`: an interrupted handoff intent is no longer rebuilt from the timeline once a user message follows the handoff receipt. Previously, after a user stop followed by a new message, a plain-text reply still ended the run with `status: "handoff"`. Rebuilding is not limited to the settling turn, so the TanStack adapter (whose settling batch has no `onTurnEnd`) still honours a handoff scheduled alongside a call that needed approval.
- 40c82dc: `memory()`: the `memory` tool now declares `replayable: false`. It stays `risk: "low"` (no approval), but `insert` / `str_replace` / `delete` / `rename` are not idempotent, so a call interrupted after it started is no longer re-run on resume; it settles as "outcome unknown" instead. Each memory call now writes a `core.tool_started` event before it executes.
- 13ec412: The perception reading now counts the threshold compaction that the projection creates in the current turn. Before, it counted only the timeline snapshot taken at the start of the turn, so on the turn where the fallback folded the oldest turns the note still said `Compactions so far: 0 (nothing has been folded; everything above is verbatim)` while the folded summary sat at the top of the same view, and every later count lagged by one. The session token total uses the same up-to-date timeline.
- 7702219: `pins()`: the `pin` tool's "already pinned" check and its `replaces` lookup now only match notes still in effect. Pinning a note back after it was replaced pins it again (instead of answering "Already pinned" while the note would not survive the next compaction), and `replaces` pointing at a note that was already replaced is an error that says so (instead of leaving both the current note and the new one in force).
- 252764c: Wording made consistent about getting folded content back. The default threshold summary no longer says removed events "can be recovered by the host"; it states that they remain in the session log, and the module that provides a recall tool says how to use it (with `compact()`, `recall`). `recall` on a tool result whose output was spilled now returns a normal (non-error) result pointing to the blob and `fetch_blob` "if that tool is in your tool list", so `haltOnFailure` no longer holds back the rest of the batch.
- 84ae969: `skills()`: the "a tool named `skill_read` already exists" check now also covers tools contributed by sockets registered before `skills()` (for example an MCP server exposing `skill_read`), matching `lazyTools()`. Previously only host tools were checked, so the menu pointed the model at another socket's tool.
- e79c6a2: `spill()`: the first-slice `end` suggested in a spill notice is now what one `fetch_blob` call can return (the smaller of the tool's `resultPolicy.maxTokens` and `maxResultTokens`), so following it is never clipped; and the default `previewChars` is derived from the tool's effective limit instead of the module-wide one, so a tool with a small limit no longer gets a preview larger than that limit.
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

## 0.10.1

### Patch Changes

- Updated dependencies [420e0f7]
  - @reinsjs/core@0.17.0

## 0.10.0

### Minor Changes

- 12d9343: `recall({ seq })` also brings back a folded user message verbatim, media included, so a screenshot the user pasted earlier is no longer lost once `compact` folds it. A compaction summary gets a second list (`MEDIA_MANIFEST_HEADING`) of folded user messages that carried images, video or audio, the receipt counts them, and the `compact` / `recall` tool descriptions and rules text mention them. The recalled message comes back as a tool result and is therefore `untrusted`. Summaries without media are unchanged; `manifest: false` turns the new list off as well. The rules text and tool descriptions changed, so the config hash of runs using `compact()` changes too.

### Patch Changes

- Updated dependencies [c47e62b]
- Updated dependencies [12d9343]
  - @reinsjs/core@0.16.0

## 0.9.0

### Minor Changes

- f8a3550: `budget()` pauses with `code: "reins.budget"` (`BUDGET_PAUSE_CODE`; pass `code: (hits) => string` to compute your own; pause codes are lowercase, so lowercase a dimension name before using it) and `compact()` pauses on its consecutive-compaction limit with `code: "reins.compact_stalled"` (`COMPACT_STALLED_PAUSE_CODE`). Both still use `reason: "budget"`; the code is what tells them apart afterwards.

### Patch Changes

- Updated dependencies [f8a3550]
  - @reinsjs/core@0.15.0

## 0.8.8

### Patch Changes

- Updated dependencies [831a50a]
  - @reinsjs/core@0.14.1

## 0.8.7

### Patch Changes

- Updated dependencies [884c840]
  - @reinsjs/core@0.14.0

## 0.8.6

### Patch Changes

- Updated dependencies [fba2410]
  - @reinsjs/core@0.13.0

## 0.8.5

### Patch Changes

- Updated dependencies [e820efb]
  - @reinsjs/core@0.12.0

## 0.8.4

### Patch Changes

- Updated dependencies [b79d193]
  - @reinsjs/core@0.11.0

## 0.8.3

### Patch Changes

- Updated dependencies [45bfc8d]
  - @reinsjs/core@0.10.0

## 0.8.2

### Patch Changes

- Updated dependencies [179f891]
  - @reinsjs/core@0.9.0

## 0.8.1

### Patch Changes

- fc3dffa: perception: a `contextTokens` limit at or above the model's context window (`contextLimit`) no longer counts toward "Run budget remaining". A single request cannot exceed the window, so that limit's remaining share just restated the context-usage line. Limits below the window are still reported. With only such a context limit configured, the budget line is omitted.

## 0.8.0

### Minor Changes

- 54fed37: Sockets can now see the current tool batch. `TurnContext.batch` (`ToolBatch`) lists the batch's tool calls, the results logged so far (in `beforeTool`, only those of earlier calls), the ids left waiting for approval, a client result or a paused sub-agent, and `resumed` when the batch is one a previous run left unfinished. It is one object updated in place during the turn. core also exports `ToolResultEvent` and `toolBatchOf(timeline, pending)`, which locates the batch of leftover calls. **`batch` is a required field**: a host that builds `TurnContext` objects itself (for example in socket unit tests) or runs its own copy of `runLoop` must fill it.

  brain adds two opt-in sockets. `haltOnFailure({ counts?, applies? })` holds back the later calls of a batch once an earlier one failed or is still waiting: each gets an error result naming that call, and nothing runs. Register it first. `stopAfter({ tools })` ends the run (`done`) at the end of a turn in which the model successfully called one of `tools`, when nothing else in the batch failed or is pending. A batch resumed after an approval also ends the run, unless the resumed run brought new user input. Register it after `handoff()` and before `compact()` / `budget()`.

  adapter-tanstack-ai fills `ctx.batch`. Because the engine checks a whole batch before running any of it, `beforeTool` sees no results from the same batch and `held` stays empty. A resumed batch gets no `onTurnEnd` on this path.

### Patch Changes

- Updated dependencies [54fed37]
  - @reinsjs/core@0.8.0

## 0.7.3

### Patch Changes

- Updated dependencies [2569456]
  - @reinsjs/core@0.7.0

## 0.7.2

### Patch Changes

- Updated dependencies [a2ee718]
  - @reinsjs/core@0.6.0

## 0.7.1

### Patch Changes

- Republish with the built output: 0.7.0 was published from a stale build and does not contain the `memory({ directories })` option.

## 0.7.0

### Minor Changes

- memory: new `directories` option declares standing directories (and their ancestors). An empty one views as an empty directory instead of "does not exist", and is listed when the model views its parent. Writes are unchanged: a standing directory cannot be written as a file or renamed onto, and deleting or renaming an empty one reports that it is empty.

## 0.6.0

### Minor Changes

- 276988e: Resident snapshots in `pins()`: a host spec can be `{ name, snapshot }`, where `snapshot(ctx)` may be async. It is taken when a segment starts — the session's first turn and the first turn after every compaction (model, forced or threshold) — and appended as a host pin only when it differs from the copy in view; within a segment it is not called again. When it changes after a compaction, the old copy is superseded and dropped from that same turn's request, so the model sees exactly one. Snapshot pins carry `meta.pin.snapshot: true` and are not carried through `handoff` (the new session takes its own). Use it for an index of the model's memory or the item it is working on, so compaction folds the work but not the context the model works from; README has a recipe. The segment helpers `modelActedSinceLastCompaction` and `timelineSoFar` moved to a shared file and are still exported from the same place. Also fixes the README example, which passed `pins({ host })` instead of `pins({ pins })`.

## 0.5.0

### Minor Changes

- 0455c28: Deliver `compact`'s request as a directive and ask twice. `SystemNotePayload` gains an optional `directive: true` for notes that ask the model to act; `@reinsjs/lowering-fetch` (all three protocols) and `@reinsjs/lowering-pi` send those as a framed `<system_note>` user message even when the model accepts mid-conversation system messages, and record the landing as `lossy(user-role)`. Measured on a pooled DeepSeek relay, the same request was ignored 4 of 4 times as a mid-conversation system message and followed 5 of 6 times as a framed user note; the official DeepSeek endpoint followed it 6 of 6 either way. Other notes (perception, pins) keep their current landing, and notes already in a log keep theirs, so cached prefixes do not change on upgrade. `compact({ force })` now asks at two lines by default (`at: [0.75, 0.8]`; a single number still works), uses blunter wording on the second request (`CompactRequestInfo.attempt`), skips the turn right after a compaction until the model has acted, and marks requests as directives unless `force.directive` is `false`.
- 24ba407: Ask the model to compact before the mechanical fallback kicks in. When the real context passes a soft line (`compact({ force: { at } })`, default `0.75` of the window) and nothing has been compacted since the last request, `compact` appends one runtime note at the end asking the model to call `compact` before doing anything else. A compaction made after such a request is recorded as `decidedBy: "forced"` (new value on `CompactionPayload.decidedBy`: the harness picked the timing, the model wrote the summary). The request is made once per segment; if the model ignores it, threshold truncation still folds mechanically at `contextLimit - reserveTokens`. Appending at the end keeps the prompt cache intact, unlike forcing `tool_choice` or narrowing the tool list. Pass `force: false` to turn it off (the default rules then drop the sentence that promises the request); `force.render` customizes the wording. `@reinsjs/eval` counts the new value separately (`CompactionCounts.forced`). The default `COMPACT_RULES` text gains one line, so sessions paused under an older version see a config change on resume.

### Patch Changes

- Updated dependencies [0455c28]
- Updated dependencies [24ba407]
- Updated dependencies [4a57a7a]
  - @reinsjs/core@0.5.0

## 0.4.0

### Minor Changes

- 6b390d0: perception: the default render no longer reports session tokens used or unfolded turns (both stay in `meta.reading` and are available to a custom `render`). Session tokens counted cache reads, so a fresh session crossed several tiers within a few steps and each crossing appended another note the model could not act on. The compactions line keeps its "what was folded" note. compact: the default rules no longer name the perception note's title, so they hold when the host renders its own status notes or does not install perception.

### Patch Changes

- fb032c1: core: the projection's threshold fallback now compares the calibrated context size — the estimate plus the fixed overhead the estimate cannot see (system prompt, tool definitions, thinking), measured from the last `budget_usage` — against `contextLimit - reserveTokens`. Before, it compared the raw estimate, so perception could report "≥85%, the harness auto-folds at 85%" while no fold happened, and a system prompt plus tool table larger than the reserve could overflow the window before the fallback ever fired. `contextOverheadOf` moves to core (brain still re-exports it) and returns 0 when the last usage record yields a non-finite value, so a malformed `budget_usage` cannot fail the run at start; `ProjectionStats.overheadTokens` is new; `project({ budget: { overheadTokens: 0 } })` restores the old comparison. The fallback now fires earlier by that overhead, and `reserveTokens` is effectively the output reserve.
- Updated dependencies [fb032c1]
  - @reinsjs/core@0.4.0

## 0.3.0

### Minor Changes

- a3afbf9: `lazyTools()` builds its menu from every tool bound before it (`SocketSetup.tools`), not only the host's — so tools contributed by an earlier socket, such as `mcpTools({ override: (t, info) => info.annotations?.readOnlyHint ? { ...t, lazy: true } : false })`, are disclosed on demand too. Register `lazyTools()` after the sockets that feed it; `lazy` tools from sockets registered later are still never hidden, and the module now warns once naming them. The "already has a tool named tool_find" check likewise looks at everything bound before it. `lazyMenuOf()` keeps its signature (the parameter was renamed).

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
