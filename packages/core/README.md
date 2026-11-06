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

**Stopping vs. aborting.** Aborting `signal` for any reason pauses the run and leaves unanswered tool calls pending, so the next run executes them first — right for a lost lease or a dropped connection. When the *user* pressed stop, abort with `controller.abort(new RunStop())` instead: every pending call (including ones waiting for approval or for a client result) is closed with an error result saying it was not executed, and the next run asks the model directly, so it can follow whatever the user says next. The result is still `paused` with reason `host` and the note `stopped by the user`.

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

Every draft goes through the same checks — type whitelist (`core.user_message`, `core.tool_result`, `core.system_note`, `ext.*`), a valid actor, the basic payload shape of the three core types, and registration in your registry — and one bad draft rejects the whole batch before anything is written; content parts cannot be mixed with drafts. The envelope (`actor`, `trust`) and the shape of your own `ext.*` payloads are yours to get right: in-process input is trusted host code. Keep one user message per batch: compaction keeps only the most recent one verbatim, while background notes fold like any other note (put what must stay in a pin). Lowering keeps the order on Chat and Responses; on Anthropic models that accept mid-conversation system messages the note lands right after the user message, because a system message may not come first or follow an assistant one. The HTTP handler in `@reinsjs/server` does not accept draft arrays — this is for in-process hosts.

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

`validate` runs before the approval check so the approver sees exactly the input that will execute. Tools without `execute` (or with `side: "client"`) pause the run until the host appends the `tool_result`. Tool output is `untrusted` by default and is wrapped in `<untrusted source="tool:…">` when lowered to the model. A tool may declare `resultTrust: "system"` to opt its **successful** results out of that wrapper — reserve it for content the host itself authored (this is how `@reinsjs/brain`'s `skill_read` works); error results and thrown exceptions stay `untrusted` regardless, and the same rule applies to client-tool results the host appends.

**Interrupted writes are not replayed.** A tool that is not replayable — by default any tool not declared `risk: "low"`; override with `replayable: true | false` — gets a model-invisible `core.tool_started` event right before `execute`. If the process dies mid-call (or a signal-aware tool is cut off by an abort), resuming does not run it again: the call is closed with "the outcome is unknown, check the current state before retrying", and the model decides whether to look first. Read-only tools are simply re-run. Declare `risk: "low"` on tools that only read; `replayable: true` on writes that are idempotent.

A tool can also *be* another agent: return `subagentPause(...)` from `execute` and the run pauses with `Interruption { kind: "subagent" }`, carrying the child session's own interruptions and state. `@reinsjs/agent` ships `asTool(agent, opts)` on top of this.

## Media: images, video and audio

Content parts are `text`, `image`, `video`, `audio` and `tool_reference`. A `video` / `audio` part carries `mime` (must start with `video/` / `audio/`), base64 `data` and an optional `durationSec` (a finite positive number); a malformed part is rejected before anything is written. A video's soundtrack is part of the video — use `audio` only for audio files.

- **Capabilities decide, not mime types.** `LoweringCapabilities.video` / `audio` are optional and mean "no" when absent: a lowering that does not take them replaces the part with a placeholder and records the event `lossy`, so the run goes on instead of the provider answering 400.
- **Estimates follow duration.** Video is estimated at 100 tokens per second and audio at 32 (measured: about 91 and 25 on a relay Gemini). Without `durationSec` the estimate falls back to the byte size at a deliberately low bitrate (1 Mbps / 64 kbps) with a 30-second floor — erring high, because bitrates differ by about 60× and underestimating leads to overflow. Give `durationSec` whenever you know it, and never `0` — a part with `durationSec: 0` (or a mime type outside `video/` / `audio/`) is malformed, and a tool result containing one is turned into JSON text as a whole, base64 included. For other rates, wrap `roughTokenEstimate` in your own `TokenEstimator`.
- **They stay in the log.** Media `data` is stored in the event like an image (append-only, never spilled) and is re-sent on every turn while it is in view. Cap the size and length of clips on your side; the model can fold what it has watched with `compact` and get it back with `recall`.

## Sockets

A `Socket` is the seam brain modules use — five hooks (`beforeModel`, `afterModel`, `beforeTool`, `afterTool`, `onTurnEnd`) plus two static contributions (`tools`, `systemPrompt`, resolved once per run so prompt caches stay warm). Anything a socket wants the model to see is emitted as an event and lands in the log first; nothing is injected around the log. Every hook gets `ctx.batch`: the tool calls of the current batch, the results logged so far (in `beforeTool`, only those of earlier calls), the ids left waiting for approval / a client result / a paused sub-agent, and `resumed` when the batch is one a previous run left unfinished. It is one object updated in place during the turn — copy what you need instead of keeping a reference. A batch is one contiguous stretch of model output (`toolBatchOf`).

## Guarantees worth knowing

- **Append-only.** Compaction, spill and handoff are all expressed as appended events. Forking a session copies a prefix verbatim (ids and `seq` kept), so references such as `recall({ seq })` survive.
- **Fail-closed reads.** An event type the registry does not know, or a version it cannot upgrade, is rejected before anything is written.
- **Bounded retry only on zero output.** A transient failure (network, 5xx, 429 — decided from the status code first, keywords only as a fallback) is retried up to 3 times, but never after a partial response has been appended: the log must not contain two half answers.
- **Rollback caveat (0.10).** Sessions that contain a `core.tool_started` event cannot be read by `@reinsjs/core` 0.9 or earlier (unknown event types are rejected).
- **Deterministic given the log.** Time and ids are injected (`now`, `newId`), so a recorded session replays byte-for-byte in tests.

## Documentation

The design documents live in `docs/` at the repository root and are written in Chinese: `docs/archive/implementation-plans/2026-09-08-技术方案v1.0.md` (spec, §6 run state, §7 sockets, §10 tools), `docs/系统全景图_模块盘点/core.md` (file-by-file map), `docs/archive/2026-10-30-决策日志DECISIONS-0.1至0.4.md`.

MIT © 2026 NewRate Limited.
