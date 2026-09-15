# @reinsjs/server

A Web-standard `(Request) => Promise<Response>` handler around the [reins](../../README.md) loop. `POST` starts or resumes a run and streams the timeline as SSE (`id:` = event `seq`); `GET` replays from `lastSeq` and joins a run in progress. No framework, no private runtime dependency — written against Web standards only; verified on Node 22 and Cloudflare workerd (strictest compat, no `nodejs_compat`), Bun / Deno / Vercel Edge not yet tested.

```bash
pnpm add @reinsjs/server
```

```ts
import { createAgentHandler } from "@reinsjs/server"

export const POST = createAgentHandler(agentDefinition, {
  principal: (req) => verifyToken(req.headers.get("authorization")),
  authorizeSession: async ({ sessionId, principal, isNew }) => {
    if (!principal) throw new Response("unauthorized", { status: 401 })
    return isNew ? true : ownsSession(principal.id, sessionId)
  },
})
```

Node's `http` module needs a tiny adapter, which is the only place `node:*` appears:

```ts
import { nodeListener } from "@reinsjs/server/node"
createServer(nodeListener(handler)).listen(8787)
```

The umbrella package `@reinsjs/agent` wraps this as `createAgent(...).handler` with the AG-UI encoder as default; used directly, this package streams raw timeline events (`rawEncoder`).

## Protocol

| request | body / query | behaviour |
| --- | --- | --- |
| `POST` | `{ input }` | new session, id returned in the `start` frame and the `X-Reins-Session` header |
| `POST` | `{ sessionId, input }` | continue a session |
| `POST` | `{ sessionId, resume, decisions }` | resume a paused run with approval decisions (`resume` is the `state` from the previous `result` frame; a decision for a sub-agent's call carries `sessionId: childSessionId`) |
| `POST` / `GET` | `lastSeq` | replay `(lastSeq, tail]` first, then continue live. `GET` also honours the `Last-Event-ID` header (so a plain `EventSource` reconnects correctly); `POST` reads `body.lastSeq` only |

Frames: `start`, one frame per event, `delta` (optional streaming increments), `result` (the `RunResult`, including a signed `state` when paused), `error`. One run per session at a time: a second `POST` while a run is active answers `409 run_in_progress` (see "Multiple instances" for what "active" means across processes).

## Security defaults

- **`authorizeSession` is not optional in multi-tenant deployments.** Without it, anyone who knows a `sessionId` can read that timeline and continue that run. Only an explicit `true` allows; `false` or `undefined` answers `404` (not `403`, which would confirm the session exists).
- **Input is whitelisted twice.** A `POST` body's `input` may be text, content parts, or a draft of type `core.user_message` or `core.tool_result` (the latter only for a pending client-side tool). Anything else — a forged `approval_decision`, a `system_note` claiming system trust, a `compaction` hiding history — is refused here with `400`, and the loop keeps its own, slightly wider, whitelist as a second line (it is not reachable through this handler).
- **Resume is validated before anything is written.** Signature (when `secret` is set), configuration hash, and the digest of pending tool calls must match the log; drift answers `409 config_mismatch` unless the host passes `allowConfigDrift`.
- **Session ids** must be non-empty printable ASCII without spaces (`400` otherwise).
- Failures after the stream has opened arrive as a `200` with an `error` frame, and the run slot is released so the session does not stay `409` forever.
- **Approval decisions are checked against the right session.** A decision without `sessionId` (or with this session's id) must point at one of this session's pending calls, else `409 unknown_tool_call`; a decision carrying a sub-agent's `childSessionId` is passed through untouched and checked by the sub-agent's own run.

## Options

| option | default | meaning |
| --- | --- | --- |
| `encode` | raw events | `StreamEncoderFactory`; `aguiEncoding()` from `@reinsjs/ui-agui` |
| `deltas` | `true` | forward streaming text/thinking deltas as `delta` frames |
| `heartbeatMs` | 15 000 | SSE comment heartbeat; `0` disables |
| `onDisconnect` | `"continue"` | or `"abort"` the run when the client goes away |
| `principal(req)` | — | who is asking; passed to the loop and tools |
| `authorizeSession(input)` | — | whether they may touch this session (see above) |
| `onEvent(event, input)` | — | side-channel observer: called once per event a run appends (see below) |
| `warn(message)` | `console.warn` | where an `onEvent` failure is reported |
| `runs` | `new InMemoryRunRegistry()` | run registry — one run per session at a time. The default only knows this process; multi-instance deployments pass `leasedRunRegistry(store.runLease)` (below) |
| `newSessionId()` | uuidv7 | id factory for new sessions |

## Multiple instances

The run registry is what turns a second `POST` on a busy session into `409`. The default `InMemoryRunRegistry` is a `Map` in this process, so **two instances behind a load balancer can both start a run on the same session**: the second one spends a model call and then fails with `seq_conflict` when it tries to append (the log stays correct — the seq check in the store is the last gate — but the call was wasted and the client sees an `error` frame instead of a clean `409`).

To make the guard span processes, share a `RunLease` through the store. `@reinsjs/store-pg` provides one (`pgStores()` includes it; the `reins_runs` table, expiry decided by the database clock, not by each instance's own), and `createAgent({ store })` installs it automatically when `store.runLease` is present. Using this package directly:

```ts
import { createAgentHandler, leasedRunRegistry } from "@reinsjs/server"

const runs = leasedRunRegistry(store.runLease, { ttlMs: 30_000 })   // one per process
createAgentHandler(agent, { runs })
```

How it behaves: `POST` acquires the lease before the run starts (held elsewhere → `409 run_in_progress`); the run renews it every `ttlMs / 3`; if a renewal comes back negative — this process was frozen for longer than `ttlMs` and another instance took over — the run is aborted and returns `paused(host)` so it can be resumed; when the run ends the lease is released (a failed release only warns; the lease expires on its own). A crashed process therefore locks its sessions for at most `ttlMs` (default 30 s).

What it does not do: `GET` only joins runs in *this* process. A reconnect that lands on another instance replays from the log up to the current tail and ends (`start.live === false`); use sticky sessions if you need the live tail after a reconnect. Any `RunLease` implementation that passes `runLeaseConformance` from `@reinsjs/core/testing` works — the semantics (heartbeat, abort on loss, release) live in `leasedRunRegistry`, not in the store.

## Observability

A run is an async generator. In-process, iterating `agent.run()` *is* observing it — every event is yielded the moment it is appended, so there is nothing to hook:

```ts
for await (const event of agent.run({ input })) log.info({ seq: event.seq, type: event.type })
```

Over HTTP the consumer of that generator is the handler itself, so it exposes the same stream as a side channel. `onEvent` is called once per event the run appends, in `seq` order, with the session id, the resolved `principal` and the originating `Request` — enough to attach a trace id or a user id to your own logs:

```ts
createAgentHandler(agent, {
  onEvent: (event, { sessionId, principal, request }) =>
    logger.info({ trace: request.headers.get("x-trace-id"), user: principal?.id, sessionId, seq: event.seq, type: event.type }),
})
```

It observes, it does not edit: the event is already in the log. Only *live* events are reported — replays (`lastSeq`, `GET` reconnects) are read back from the log and not observed again — and only this session's: a sub-agent started with `asTool` runs in its own session and does not pass through the handler. The hook never slows or breaks the run: the event is pushed to SSE subscribers first, async return values are chained in event order without blocking the loop, and a throw or rejection is reported once per run through `warn`. The run's `result` frame (and `ActiveRun.done`, hence a Worker's `waitUntil`) waits for the chain to settle, so the last observation is flushed before the run is declared finished. The flip side: a hook that never settles keeps the run open and the session `409` — wrap slow sinks in your own timeout.

## Documentation

`docs/技术方案.md` §12, `docs/模块盘点/server.md`, `README.md` at the repository root ("Security notes") — in Chinese unless noted.

MIT © 2026 NewRate Limited.
