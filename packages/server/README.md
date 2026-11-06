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
| `POST` | `{ sessionId, stop: true }` | the user pressed stop. Answers JSON `{ status: "stopping" | "idle", sessionId }` right away (no stream). A run active in this process is aborted with `RunStop` and its stream still ends with the `result` frame; an idle session with pending calls gets a short run that only closes them as not executed; otherwise `idle`. Must not be combined with `input` / `resume` / `decisions`. Only runs of this process can be stopped |
| `POST` | `{ sessionId, input, deliveryId? }` while a run is active, with `midRunInput: true` | the message is queued into that run and answers JSON `202 { status: "queued", sessionId, deliveryId }` (no stream); see "Messages during a run" |
| `POST` / `GET` | `lastSeq` | replay `(lastSeq, tail]` first, then continue live. `GET` also honours the `Last-Event-ID` header (so a plain `EventSource` reconnects correctly); `POST` reads `body.lastSeq` only |

Frames: `start`, one frame per event, `delta` (optional streaming increments), `result` (the `RunResult`, including a signed `state` when paused), `error`. One run per session at a time: a second `POST` while a run is active answers `409 run_in_progress` unless `midRunInput` queues it (see "Multiple instances" for what "active" means across processes).

## Security defaults

- **`authorizeSession` is not optional in multi-tenant deployments.** Without it, anyone who knows a `sessionId` can read that timeline and continue that run. Only an explicit `true` allows; `false` or `undefined` answers `404` (not `403`, which would confirm the session exists). `method` is `"GET"`, `"POST"` or `"STOP"` — a hook that allows writes only when `method === "POST"` therefore refuses stop requests until it names `"STOP"` too.
- **Input is whitelisted twice.** A `POST` body's `input` may be text, content parts, or a draft of type `core.user_message` or `core.tool_result` (the latter only for a pending client-side tool). Anything else — a forged `approval_decision`, a `system_note` claiming system trust, a `compaction` hiding history — is refused here with `400`, and the loop keeps its own, slightly wider, whitelist as a second line (it is not reachable through this handler). An array `input` must be a non-empty list of `text` / `image` parts; every part — and the content of a draft — is rebuilt from its known fields only, so extra fields never reach the loop. Arrays of event drafts (a host briefing plus a task, see `@reinsjs/core`) are for in-process hosts only and are refused here.
- **Resume is validated before anything is written.** Signature (when `secret` is set) and the digest of pending tool calls must match the log, and the model and the definitions of the tools behind the pending calls must be unchanged (states from before 0.10 still compare the whole configuration hash); drift answers `409 config_mismatch` unless the host passes `allowConfigDrift`.
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
| `midRunInput` | `false` | queue user messages that arrive while a run is active into that run instead of answering `409` (see below) |
| `runs` | `new InMemoryRunRegistry()` | run registry — one run per session at a time. The default only knows this process; multi-instance deployments pass `leasedRunRegistry(store.runLease)` (below) |
| `newSessionId()` | uuidv7 | id factory for new sessions |

## Messages during a run

With `midRunInput: true`, a user who types while the agent is working ("only account A", "keep the budget under 100") does not have to wait for the run or stop it. The message goes into a per-run, in-memory mailbox, and the run writes it into the timeline right before its next model call (the `pullInput` semantics of `@reinsjs/core`). The draft carries `provenance: { source: USER_DELIVERY_SOURCE, ref: deliveryId }`; `@reinsjs/ui-agui` copies that onto the user message's `TEXT_MESSAGE_START` as `metadata.reins.provenance`.

**Delivered means one thing: the timeline holds a `core.user_message` whose `provenance.ref` is your `deliveryId`.** There is no list of undelivered messages in the `result` frame; whatever is still in the mailbox when the run ends is dropped.

A message is queued only when all of these hold: the body has `sessionId` and a user-message `input` (text, content parts or a `core.user_message` draft) and no `resume` / `decisions`; the session's run is active **in this process**, was started by a plain `POST` through a handler with `midRunInput: true` that shares this handler's `runs`, and has not been aborted; and the sender is the run's starter (same `principal?.id`, or both anonymous) — a run executes as the principal it started with, so someone else's words must not run under that identity. Otherwise the request takes the normal path, so the answer is one of:

| answer | meaning | what the client does |
| --- | --- | --- |
| `202 queued` | in the current run's mailbox | watch the stream that carries the run; if it ends (`result` / `error`) without the message, it was not delivered. If the stream had already ended when the `202` arrived, it was not delivered |
| SSE `200` | the run had just ended, so this message started a new run | read it like any `POST`; the message is the run's input, with the same provenance |
| `409 run_in_progress` | stopping or aborted, another instance, another principal, a stop clean-up run, a run started by a handler without `midRunInput`, or the instant between the run being registered and its mailbox opening | resend later, or tell the user |
| `429 mailbox_full` | 16 messages are waiting to be written | resend later |

- Generate the `deliveryId` before sending and **always** send it with `lastSeq` (`deliveryId`: printable ASCII without spaces, at most 128 characters; it may be omitted, then the server makes one and returns it in the `202`). A plain `POST` that starts a run carries it too, so every message is checked the same way. A retry with the same id is idempotent within one run; across runs, look for the ref in the events you already have before resending.
- A host that builds a handler per request (for example, tools assembled from per-session credentials) gets mid-run input as long as every handler is created with the same `runs` instance — the same requirement as for `409` and stop requests to work across them.
- You need a stream attached to the run to see the message arrive: the `POST` that started it, or `GET ?sessionId&lastSeq` to reconnect.
- If the stream ends with an `error` frame (for example a `seq_conflict` or a storage timeout while writing), whether the message was written is unknown: replay with `GET` and look for the ref before putting the text back in the input box.
- Typical reasons a queued message is not delivered: it arrived after the run's last model call; the run paused (approval, budget, stop, `maxTurns`) or failed; it was aborted right after taking the message; it ended with a **handoff** (send to `toSessionId` instead); a resumed run's catch-up turn does not take new input. When the run paused for approval, send the undelivered text together with your `decisions` — only the client knows how to combine them; the handler never starts a run by itself.
- Mid-run messages make runs longer: `maxTurns` and budgets are reached sooner, nothing resets them.
- The mailbox lives in this process only: a crash loses undelivered messages (the client sees them missing and resends). Limit request body size at your gateway; the mailbox caps the count, not the size. `authorizeSession` sees `method: "POST"` for a queued message — a host that counts `POST`s as runs counts these too — and `onEvent` keeps reporting the starting request's `principal` / `request`.

```ts
/** Send one message; the caller keeps the deliveryId (and reuses it when retrying). */
async function send(endpoint: string, sessionId: string, deliveryId: string, text: string, lastSeq: number) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, input: text, deliveryId, lastSeq }),
  })
  if (res.status === 202) return { kind: "queued" } as const // watch the run's stream for it
  if (res.status === 200) return { kind: "started", stream: res } as const // a new run, read as usual
  if (res.status === 409 || res.status === 429) return { kind: "retry-later" } as const
  throw new Error(`send failed with ${res.status}`)
}

/** Delivered ⟺ the timeline holds the user message carrying this deliveryId. */
const delivered = (events: readonly Event[], deliveryId: string) =>
  events.some(
    (e) =>
      e.type === "core.user_message" &&
      e.provenance?.source === USER_DELIVERY_SOURCE &&
      e.provenance.ref === deliveryId,
  )
```

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

`docs/archive/implementation-plans/2026-09-08-技术方案v1.0.md` §12, `docs/系统全景图_模块盘点/server.md`, `README.md` at the repository root ("Security notes") — in Chinese unless noted.

MIT © 2026 NewRate Limited.
