# @reins/core

The kernel of [reins](../../README.md): an append-only event timeline, the projection that decides what the model sees on each turn, a loop of a few hundred lines you can read and copy, a serializable run state for pause/resume across processes, and the `Socket` seam that everything else plugs into. Zero dependencies, zero `node:*` — Web standards only; verified on Node 22 and Cloudflare workerd, Bun / Deno / Vercel Edge not yet tested.

Two principles shape every type in here:

1. **Decisions default to the model.** The loop lets the model see (projection, perception notes), gives it means (tools), gives it bounds (budgets, approval, safety nets) and records everything. It does not decide on the model's behalf.
2. **The timeline is the single source of truth; roles are a translation.** There is one kind of data: an `Event` with an `actor` (`user` / `model` / `tool` / `system` / `host`). Provider message roles only appear in the lowering layer, and every lossy landing is declared.

```bash
pnpm add @reins/core
```

Most applications import the umbrella package `reins` instead; `@reins/core` is for people who bring their own loop, transport or lowering layer.

## What is in the box

| module | exports | purpose |
| --- | --- | --- |
| `events/` | `Event`, `EventDraft`, `createCoreRegistry`, `createEvent`, `CoreEvent` types | Event shell + payloads, `schemaVersion` on every type, upcast-on-read (unknown types are rejected, not skipped) |
| `store/` | `EventLog`, `BlobStore`, `MemoryStore`, `InMemory*`, `memoryStore()`, `readTimeline` | Storage contracts. `EventLog.append` is the only write; `seq` is assigned by the caller and must be contiguous (optimistic concurrency) |
| `projection/` | `project`, `ProjectionStrategy`, `DEFAULT_MODEL_INVISIBLE_TYPES` | Pure function: timeline → what the model sees this turn (filter → fold → pin → trim to budget). Strategies may create events, but they go through the loop into the log first |
| `lowering/` | `Lowering`, `LoweredRequest`, `LandingRecord`, `markUntrusted` | Interface to a provider wire protocol plus the loss matrix types; implementation in `@reins/lowering-pi` |
| `loop/` | `runLoop`, `Socket`, `Tool`, `defineTool`, `RunResult`, `SerializedRunState`, `Interruption`, `subagentPause`, `retry` | The default loop and its seams |
| `replay/` | `replayTurns` | Recompute what the model saw on every turn from the log alone (audit UIs, eval) |
| `@reins/core/testing` | `ScriptedLowering`, `callTool`, `say`, `think`, store conformance suites | Deterministic model scripts and a suite any `EventLog` / `BlobStore` / `MemoryStore` implementation should pass |

## The loop in one paragraph

`runLoop(config)` is an exported async generator. Each iteration reads the timeline, projects it, lets every `Socket.beforeModel` patch the view / tools / system prompt, asks the model (with bounded retry on transient failures only while no output has landed), appends each output block as it arrives, runs the tools through `beforeTool` → `validate` → approval → `execute` → `afterTool`, appends a `budget_usage`, and asks `onTurnEnd` whether to continue, stop, pause or hand off. It returns one of four results:

```ts
type RunResult =
  | { status: "done"; sessionId; lastSeq }
  | { status: "paused"; sessionId; lastSeq; reason: "approval" | "budget" | "host"; interruptions: Interruption[]; state: SerializedRunState }
  | { status: "handoff"; sessionId; lastSeq; toSessionId }
  | { status: "error"; sessionId; lastSeq; error }
```

Pausing is a return value, not a blocking callback. `state` is small (ids and hashes, HMAC-signed when you pass `secret`) and enough to resume in another process: `runLoop({ ...config, resume: state, decisions: [...] })` re-validates it against the log (config drift, pending-call digest) before writing anything.

## Tools

```ts
import { defineTool } from "@reins/core"

const deploy = defineTool<{ env: "staging" | "prod" }>({
  name: "deploy",
  description: "Ship the current build",
  inputSchema: { type: "object", properties: { env: { type: "string", enum: ["staging", "prod"] } }, required: ["env"] },
  needsApproval: true, // the model may decide to call it; a person must confirm before it runs
  risk: "high",
  execute: ({ env }, ctx) => `deployed to ${env}`,
})
```

`validate` runs before the approval check so the approver sees exactly the input that will execute. Tools without `execute` (or with `side: "client"`) pause the run until the host appends the `tool_result`. Tool output is `untrusted` by default and is wrapped in `<untrusted source="tool:…">` when lowered to the model.

A tool can also *be* another agent: return `subagentPause(...)` from `execute` and the run pauses with `Interruption { kind: "subagent" }`, carrying the child session's own interruptions and state. `reins` ships `asTool(agent, opts)` on top of this.

## Sockets

A `Socket` is the seam brain modules use — five hooks (`beforeModel`, `afterModel`, `beforeTool`, `afterTool`, `onTurnEnd`) plus two static contributions (`tools`, `systemPrompt`, resolved once per run so prompt caches stay warm). Anything a socket wants the model to see is emitted as an event and lands in the log first; nothing is injected around the log.

## Guarantees worth knowing

- **Append-only.** Compaction, spill and handoff are all expressed as appended events. Forking a session copies a prefix verbatim (ids and `seq` kept), so references such as `recall({ seq })` survive.
- **Fail-closed reads.** An event type the registry does not know, or a version it cannot upgrade, is rejected before anything is written.
- **Bounded retry only on zero output.** A transient failure (network, 5xx, 429 — decided from the status code first, keywords only as a fallback) is retried up to 3 times, but never after a partial response has been appended: the log must not contain two half answers.
- **Deterministic given the log.** Time and ids are injected (`now`, `newId`), so a recorded session replays byte-for-byte in tests.

## Documentation

The design documents live in `docs/` at the repository root and are written in Chinese: `docs/技术方案.md` (spec, §6 run state, §7 sockets, §10 tools), `docs/模块盘点/core.md` (file-by-file map), `docs/DECISIONS.md`.

MIT.
