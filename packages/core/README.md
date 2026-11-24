# @reinsjs/core

The kernel of [reins](../../README.md): an append-only event timeline, the projection that decides what the model sees on each turn, a loop of a few hundred lines you can read and copy, a serializable run state for pause/resume across processes, and the `Socket` seam that everything else plugs into. Zero dependencies, zero `node:*` — Web standards only; verified on Node 22, Cloudflare workerd (strictest compat), Bun, Deno and Vercel's Edge Runtime (`spikes/runtime-matrix`).

Two principles shape every type in here:

1. **Decisions default to the model.** The loop lets the model see (projection, perception notes), gives it means (tools), gives it bounds (budgets, approval, safety nets) and records everything. It does not decide on the model's behalf.
2. **The timeline is the single source of truth; roles are a translation.** There is one kind of data: an `Event` with an `actor` (`user` / `model` / `tool` / `system` / `host`). Provider message roles only appear in the lowering layer, and every lossy landing is declared.

```bash
pnpm add @reinsjs/core
```

Most applications import the umbrella package `@reinsjs/agent` instead; `@reinsjs/core` is for people who bring their own loop, transport or lowering layer.

## What is in the box

| module | exports | purpose |
| --- | --- | --- |
| `events/` | `Event`, `EventDraft`, `createCoreRegistry`, `createEvent`, `CoreEvent` types | Event shell + payloads, `schemaVersion` on every type, upcast-on-read (unknown types are rejected, not skipped) |
| `store/` | `EventLog`, `BlobStore`, `MemoryStore`, `InMemory*`, `memoryStore()`, `readTimeline` | Storage contracts. `EventLog.append` is the only write; `seq` is assigned by the caller and must be contiguous (optimistic concurrency) |
| `projection/` | `project`, `ProjectionStrategy`, `DEFAULT_MODEL_INVISIBLE_TYPES` | Pure function: timeline → what the model sees this turn (filter → fold → pin → trim to budget). Strategies may create events, but they go through the loop into the log first |
| `lowering/` | `Lowering`, `LoweredRequest`, `LandingRecord`, `markUntrusted` | Interface to a provider wire protocol plus the loss matrix types; implementations in `@reinsjs/lowering-fetch` (zero-dependency) and `@reinsjs/lowering-pi` (pi-ai) |
| `loop/` | `runLoop`, `Socket`, `Tool`, `defineTool`, `RunResult`, `SerializedRunState`, `Interruption`, `subagentPause`, `retry` | The default loop and its seams |
| `replay/` | `replayTurns` | Recompute what the model saw on every turn from the log alone (audit UIs, eval) |
| `@reinsjs/core/testing` | `ScriptedLowering`, `callTool`, `say`, `think`, store conformance suites | Deterministic model scripts and a suite any `EventLog` / `BlobStore` / `MemoryStore` implementation should pass |

## The loop in one paragraph

`runLoop(config)` is an exported async generator. Each iteration reads the timeline, projects it, lets every `Socket.beforeModel` patch the view / tools / system prompt, asks the model (with bounded retry on transient failures only while no output has landed), appends each output block as it arrives, runs the tools through `beforeTool` → `validate` → approval → `execute` → `afterTool`, appends a `budget_usage`, and asks `onTurnEnd` whether to continue, stop, pause or hand off. It returns one of four results:

```ts
type RunResult =
  | { status: "done"; sessionId; lastSeq }
  | { status: "paused"; sessionId; lastSeq; reason: "approval" | "budget" | "host"; interruptions: Interruption[]; state: SerializedRunState }
  | { status: "handoff"; sessionId; lastSeq; toSessionId }
  | { status: "error"; sessionId; lastSeq; error }
```

Pausing is a return value, not a blocking callback. `state` is small (ids and hashes, HMAC-signed when you pass `secret`) and enough to resume in another process: `runLoop({ ...config, resume: state, decisions: [...] })` re-validates it against the log (signature, pending-call digest, and that the model and the definitions of the tools behind the pending calls are unchanged — adding or removing other tools no longer blocks a resume; the model is told about the change instead) before writing anything. The same signed `state` is also written into the `core.run_paused` event (model-invisible), so whoever reads the log later can resume too: `pausedStateOf(lastEvent)` returns it when the session's last event is that pause, and `undefined` once anything else has been appended.

**Stopping vs. aborting.** Aborting `signal` for any reason pauses the run (when it lands mid tool batch, without calling `onTurnEnd`). Calls the model had finished asking for are left pending, so the next run executes them first — right for a lost lease or a dropped connection. Calls from a model response that was cut off by the abort are not: they get an error result saying the response was interrupted (`MODEL_INTERRUPTED_NOT_EXECUTED_TEXT`), since their arguments may be incomplete. When the *user* pressed stop, abort with `controller.abort(new RunStop())` instead: every pending call (including ones waiting for approval or for a client result) is closed with an error result saying it was not executed, and the next run asks the model directly, so it can follow whatever the user says next. The result is still `paused` with reason `host` and the note `stopped by the user`.

**Handoff.** When `onTurnEnd` returns `{ handoff }`, the loop appends `core.handoff` to this session and opens the new one with the summary as a `system_note`, then `intent.opening`, then the `triggerMessage` as a `user_message` (`handoffOpeningDrafts`). Each opening event names who really wrote it: the summary belongs to whoever decided the handoff (`intent.by`, default `"model"`), and so does a trigger message — unless it repeats one of this session's `actor: "user"` messages word for word (ignoring surrounding whitespace), in which case it is recorded as the user's with that message's trust and `provenance.ref` pointing at it. The other opening events carry `provenance: { source: "handoff", ref: <the core.handoff event id> }`. What the model sees is unchanged; trust markers only wrap `untrusted` content.

**Approval and a change of mind.** If the user sends a new message instead of approving a pending call, resume with `decisions: [{ toolCallId, approved: false, by, reason }]` (or stop); otherwise the call is held for approval again before the model reads the new message.

## Input: background and task in one run

`input` takes a string, content parts, one event draft, or an array of drafts appended in order in one write. Use the array when a run brings both something to do and something to know, so the model can tell a colleague's request from the host's briefing:

```ts
/** Host briefing as a system note, then the actual request. One user message per batch. */
function briefedInput(background: string, request: string): EventDraft[] {
  return [
    { type: "core.system_note", actor: "host", payload: { kind: "host", text: background } },
    { type: "core.user_message", actor: "user", payload: { content: [{ type: "text", text: request }] } },
  ]
}

runLoop({ ...config, input: briefedInput("Ticket #12 was edited by Ana an hour ago.", "Review ticket #12.") })
```

Every draft goes through the same checks — type whitelist (`core.user_message`, `core.tool_result`, `core.system_note`, `ext.*`), a valid actor, the basic payload shape of the three core types, that each `core.tool_result` answers a call that is still pending and not waiting for approval (same `name`, at most once per batch — a duplicate or orphan result would be replayed to the provider on every later request, and a result for a call awaiting approval would skip it: pass `decisions` first), and registration in your registry — and one bad draft rejects the whole batch before anything is written; content parts cannot be mixed with drafts. The envelope (`actor`, `trust`) and the shape of your own `ext.*` payloads are yours to get right: in-process input is trusted host code. Keep one user message per batch: compaction keeps only the most recent one verbatim, while background notes fold like any other note (put what must stay in a pin). Lowering keeps the order on Chat and Responses; on Anthropic models that accept mid-conversation system messages the note lands right after the user message, because a system message may not come first or follow an assistant one. The HTTP handler in `@reinsjs/server` does not accept draft arrays — this is for in-process hosts.

## Input that arrives mid-run

A run can take minutes. Messages that reach your host meanwhile (a teammate changed direction, someone signed off a plan) can be handed to the model before its next call instead of waiting for the run to end. Pass `pullInput`: the loop calls it before every model call — not on a turn that only finishes leftover tool calls, and not once `maxTurns` is reached — and appends whatever drafts it returns, ahead of that turn's socket notes. Your queue stays the source of truth: offer what is waiting, and claim a delivery only when its event comes back out of the loop.

```ts
/** A host mailbox: offer everything unclaimed at each gap; claim when the loop has written it. */
function mailbox() {
  const waiting = new Map<string, string>()
  return {
    post(id: string, text: string) {
      waiting.set(id, text)
    },
    pullInput: (): EventDraft[] =>
      [...waiting].map(([id, text]) => ({
        type: "core.user_message",
        actor: "user",
        provenance: { source: "mailbox", ref: id },
        payload: { content: [{ type: "text", text }] },
      })),
    claim(event: Event) {
      if (event.provenance?.source === "mailbox" && event.provenance.ref) waiting.delete(event.provenance.ref)
    },
  }
}

const box = mailbox()
for await (const event of runLoop({ ...config, input: "Plan the shoot.", pullInput: box.pullInput })) box.claim(event)
```

- Claim while handling the event, before asking the loop for the next one. If you only claim later, the next gap offers the same drafts again and they are written twice.
- Only `core.user_message`, `core.system_note` and `ext.*` are accepted here (no `core.tool_result`: there is no open call to answer at that point). A return value that is not an array, or holds anything else, ends the run with `status: "error"` and writes none of the batch. If the callback throws, the loop records a `core.error` the model cannot see and carries on; the messages are still in your queue. If the run is aborted while you were pulling, the drafts are not written.
- Anything that arrives after the last pull is not part of this run: check your queue once more when the run returns. A callback that never settles stalls the run, so put your own timeout on it.
- A run that absorbs follow-ups lives longer: per-run budget limits (turns, wall time, tokens) trip sooner.
- On Anthropic models that accept mid-conversation system messages, a mid-run `system_note` follows a tool result, so it becomes a real system message placed after the user message; at the start of a run it usually follows an assistant reply and is sent as tagged user text instead.
- `pullInput` is per run: `runLoop` and `agent.run()` take it; agent definitions, the HTTP handler and `asTool` sub-agents do not.

## Tools

```ts
import { defineTool } from "@reinsjs/core"

const deploy = defineTool<{ env: "staging" | "prod" }>({
  name: "deploy",
  description: "Ship the current build",
  inputSchema: { type: "object", properties: { env: { type: "string", enum: ["staging", "prod"] } }, required: ["env"] },
  needsApproval: true, // the model may decide to call it; a person must confirm before it runs
  risk: "high",
  execute: ({ env }, ctx) => `deployed to ${env}`,
})
```

`validate` runs before the approval check so the approver sees exactly the input that will execute. Tools without `execute` (or with `side: "client"`) pause the run until the host appends the `tool_result` — use the `toolCallId` of the logged `core.tool_call` (or `run_paused.awaiting`): call ids are unique within a session, and when a provider reuses an id from an earlier call or sends none, the loop logs the call under a fresh `reins_…` id and keeps the original in `payload.meta.originalToolCallId`. Tool output is `untrusted` by default and is wrapped in `<untrusted source="tool:…">` when lowered to the model. A tool may declare `resultTrust: "system"` to opt its **successful** results out of that wrapper — reserve it for content the host itself authored (this is how `@reinsjs/brain`'s `skill_read` works); error results and thrown exceptions stay `untrusted` regardless, and the same rule applies to client-tool results the host appends.

**Interrupted writes are not replayed.** A tool that is not replayable — by default any tool not declared `risk: "low"`; override with `replayable: true | false` — gets a model-invisible `core.tool_started` event right before `execute`. If the process dies mid-call (or a signal-aware tool is cut off by an abort), resuming does not run it again: the call is closed with "the outcome is unknown, check the current state before retrying", followed by the time the call started (`This call started at 2026-11-08T16:08:02.123Z.`, from the `core.tool_started` event), and the model decides whether to look first. The time lets the model tell the object this call created from an earlier one with the same parameters; make your read tools report timestamps in an unambiguous form (UTC ISO is safest). The exported text constants are exact prefixes of what lands — compare with `startsWith`, not `===`. Read-only tools are simply re-run. Declare `risk: "low"` on tools that only read; `replayable: true` on writes that are idempotent.

A tool can also *be* another agent: return `subagentPause(...)` from `execute` and the run pauses with `Interruption { kind: "subagent" }`, carrying the child session's own interruptions and state. `@reinsjs/agent` ships `asTool(agent, opts)` on top of this.

## Media: images, video and audio

Content parts are `text`, `image`, `video`, `audio` and `tool_reference`. A `video` / `audio` part carries `mime` (must start with `video/` / `audio/`), base64 `data` and an optional `durationSec` (a finite positive number); a malformed part is rejected before anything is written. A video's soundtrack is part of the video — use `audio` only for audio files. An `image` part's `mime` must be one of `image/jpeg`, `image/png`, `image/gif` or `image/webp` (`SUPPORTED_IMAGE_MIMES`, checked by `isSupportedImageMime`), inline or by reference: providers reject other types with a 400, and since the log only grows, one such part written into a session would fail every later request. In a tool result, an image part that is well formed except for its type is replaced by a short sentence naming the type (`unsupportedImageText`); the other parts are kept, and the bytes never reach the model. Convert SVG or HEIC to PNG / JPEG in the tool if the model should see it. Content parts in `input`, by contrast, are rejected with `RangeError`.

- **Capabilities decide, not mime types.** `LoweringCapabilities.video` / `audio` are optional and mean "no" when absent: a lowering that does not take them replaces the part with a placeholder and records the event `lossy`, so the run goes on instead of the provider answering 400.
- **Estimates follow duration.** Video is estimated at 100 tokens per second and audio at 32 (measured: about 91 and 25 on a relay Gemini). Without `durationSec` the estimate falls back to the byte size at a deliberately low bitrate (1 Mbps / 64 kbps) with a 30-second floor — erring high, because bitrates differ by about 60× and underestimating leads to overflow. Give `durationSec` whenever you know it, and never `0` — a part with `durationSec: 0` (or a mime type outside `video/` / `audio/`) is malformed, and a tool result containing one is turned into JSON text as a whole, base64 included. For other rates, wrap `roughTokenEstimate` in your own `TokenEstimator`.
- **They stay in the log.** Media `data` is stored in the event like an image (append-only, never spilled) and is re-sent on every turn while it is in view. Cap the size and length of clips on your side. With `@reinsjs/brain`'s `compact`, the model can fold what it has seen and bring it back with `recall({ seq })`: from a tool result, or from a user message (a summary lists folded user messages that carried media by `seq`).

### Images by reference

An image can also be a reference: `{ type: "image", mime, blobId }`. The bytes live in the `BlobStore` (`LoopConfig.blobs`) and the log keeps only the id, so a session with many screenshots stays small and a picture is stored once. `put` the **raw bytes** (not a base64 string) under the session's id, then send the reference — `put` does not require the session to exist yet.

- **What the model sees is unchanged.** Right before each model call the loop swaps the references that are in view for inline images (`hydrateImageRefs`), so the request is byte-for-byte what the inline form would produce. Folded images are not read at all. Sockets and the token estimate keep seeing the reference (an image counts 1 600 tokens either way). Each blob is read at most once per run.
- **References are checked before anything is written** — the initial `input` (`RangeError`, nothing written), messages pulled mid-run (the run ends with a `core.error` of category `input`), tool results (only the offending part is replaced with the sentence below; the rest of the result is kept), and the HTTP handler (`400`). A reference is accepted when the blob belongs to this session, or when this session's timeline already shows it as an image (a forked session can show its parent's pictures), and its `mime` equals the blob's. Every failure — missing blob, someone else's blob, wrong mime, no `BlobStore` — reads `Blob <id> not found in this session`, so a client cannot probe other sessions. A storage error while checking is not a rejection: the initial `input` rethrows it, a mid-run pull logs it and tries again later, a tool result gets `Could not read blob <id>: storage error` in place of that part, with the cause in a model-invisible `core.error`.
- **Shape.** `mime` must be one of the four supported image types (see above); `blobId` is 1–128 characters; `data` and `blobId` never appear together. A spilled tool output (a text blob) can therefore never pass as an image.
- **When the bytes are gone.** If a referenced blob no longer exists (you deleted it, or there is no `BlobStore`), the lowering writes `[image unavailable]` in its place and records the event `lossy`; the run goes on. Any other storage error fails the model call like a network error (retried if transient), so the model never answers a placeholder because of a hiccup.
- **Blobs are immutable.** A `BlobStore` must never reuse an id or change bytes after `put`: "the log plus its blobs" is what the model saw. Replaying a session through a lowering (`replayTurns` + `toRequest`) needs the same `BlobStore` — call `hydrateImageRefs` first, as `examples/minimal/replay.ts` does.
- **Reads are concurrent.** Checking a batch of references and swapping the images in view each read the uncached blobs in one wave — up to 16 at a time, each id once — then judge them in order, so the first problem reported is the same as one-by-one reading would give. On object storage, ten new images cost one round trip instead of ten. Need a lower limit? Throttle inside your `BlobStore`.
- **Optional `stat(id)`.** A `BlobStore` may add `stat(id): Promise<BlobMeta>` that returns the metadata without the bytes. It must throw `StoreError("not_found")` for an unknown id (never return `null`) and must equal `get(id).meta`; `blobStoreConformance` checks both. Only the HTTP handler's pre-check uses it — the loop still decides with `get`, so the bytes sent to the provider and the check that let them into the log come from the same read. A `get` or `stat` that returns something other than an object is treated as not found.
- **Forks and cleanup.** `fork` copies events, not blobs; a forked session points at its parent's blobs. If you delete a parent session's blobs, references in its forks show as unavailable.
- **Only images.** Video and audio stay inline for now. The model has no separate "look again" tool: `recall({ seq })` brings back a folded message, and its result keeps the reference, so nothing is stored twice.
- **Paths without a `runLoop`.** The TanStack AI adapter neither checks nor loads blobs: a reference becomes `[image unavailable]` there (recorded `lossy`), and references in tool results are replaced with that text before they are logged. Hosts that call `toRequest` directly must call `hydrateImageRefs` themselves.

## Sockets

A `Socket` is the seam brain modules use — five hooks (`beforeModel`, `afterModel`, `beforeTool`, `afterTool`, `onTurnEnd`) plus two static contributions (`tools`, `systemPrompt`, resolved once per run so prompt caches stay warm). Anything a socket wants the model to see is emitted as an event and lands in the log first; nothing is injected around the log. Every hook gets `ctx.batch`: the tool calls of the current batch, the results logged so far (in `beforeTool`, only those of earlier calls), the ids left waiting for approval / a client result / a paused sub-agent, and `resumed` when the batch is one a previous run left unfinished. It is one object updated in place during the turn — copy what you need instead of keeping a reference. A batch is one contiguous stretch of model output (`toolBatchOf`).

## Guarantees worth knowing

- **Append-only.** Compaction, spill and handoff are all expressed as appended events. Forking a session copies a prefix verbatim (ids and `seq` kept), so references such as `recall({ seq })` survive.
- **Fail-closed reads.** An event type the registry does not know, or a version it cannot upgrade, is rejected before anything is written.
- **Bounded retry only on zero output.** A transient failure (network, 5xx, 429 — decided from the status code first, keywords only as a fallback) is retried up to 3 times, but never after a partial response has been appended: the log must not contain two half answers.
- **Rollback caveat (0.10).** Sessions that contain a `core.tool_started` event cannot be read by `@reinsjs/core` 0.9 or earlier (unknown event types are rejected).
- **Every run is bracketed (0.14).** `runLoop` starts each run with a model-invisible `core.tools_bound` (`marksEnd: true`) and ends it with exactly one end marker: `core.run_paused` for a pause (now with `awaiting` — the calls waiting on an approval, a client tool or a sub-agent — and `stopped` for a user stop), or `core.run_ended` with `status: "done" | "handoff" | "error"`. A `core.error` the loop retries past, or one from a throwing `pullInput`, gets no `run_ended`. `runStatusOf({ held, lastMarker })` turns a lease flag and `lastRunMarker(timeline)` into running / paused / done / handoff / error / interrupted / idle / unknown; `@reinsjs/store-pg` has `pgRunStates` for a whole session list in one statement. Sessions containing `core.run_ended` cannot be read by 0.13 or earlier: upgrade every instance together and do not roll back.
- **Pause codes (0.15).** A socket's `pause` may carry a `code` — your own short identifier such as `acme.credits_exhausted` — next to `reason` and `note`. It is written into `core.run_paused` together with the note and comes back as `RunStatus.paused.code`, so another request or process can tell why the run paused without guessing. reins never branches on it and it is not part of the resume state. Format: `PAUSE_CODE_RE` (lowercase letters, digits, `_ . : -`, starting with a letter or digit, at most 64 characters); a code that does not match is dropped — the run still pauses, and a model-invisible `core.error` (category `input`, `detail.phase: "onTurnEnd"`, no `run_ended` after it) is logged just before the `core.run_paused`. The same happens when `reason` is anything but `"budget"` or `"host"`: the run pauses with `host`. Put your own reasons in `code`. The `reins.` prefix is used by built-in sources: `reins.max_turns` (the loop's `maxTurns` limit), `reins.budget` and `reins.compact_stalled` (from `@reinsjs/brain`). Aborts and user stops carry no code. A paused sub-agent's code stays in the child session — look it up through `awaiting[].childSessionId`.
- **Rollback caveat (0.16).** `core.user_message` and `core.tool_result` are now written as schema v2 (v1 reads as v2 unchanged), because their content may hold image references. Sessions written by 0.16 cannot be read by 0.15 or earlier (`future_version`): upgrade every instance together and do not roll back.
- **Deterministic given the log.** Time and ids are injected (`now`, `newId`), so a recorded session replays byte-for-byte in tests.

## Documentation

The design documents live in `docs/` at the repository root and are written in Chinese: `docs/archive/implementation-plans/2026-09-08-技术方案v1.0.md` (spec, §6 run state, §7 sockets, §10 tools), `docs/系统全景图_模块盘点/core.md` (file-by-file map), `docs/archive/2026-10-30-决策日志DECISIONS-0.1至0.4.md`.

MIT © 2026 NewRate Limited.
