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

The umbrella package `reins` wraps this as `createAgent(...).handler` with the AG-UI encoder as default; used directly, this package streams raw timeline events (`rawEncoder`).

## Protocol

| request | body / query | behaviour |
| --- | --- | --- |
| `POST` | `{ input }` | new session, id returned in the `start` frame and the `X-Reins-Session` header |
| `POST` | `{ sessionId, input }` | continue a session |
| `POST` | `{ sessionId, resume, decisions }` | resume a paused run with approval decisions (`resume` is the `state` from the previous `result` frame; a decision for a sub-agent's call carries `sessionId: childSessionId`) |
| `POST` / `GET` | `lastSeq` | replay `(lastSeq, tail]` first, then continue live. `GET` also honours the `Last-Event-ID` header (so a plain `EventSource` reconnects correctly); `POST` reads `body.lastSeq` only |

Frames: `start`, one frame per event, `delta` (optional streaming increments), `result` (the `RunResult`, including a signed `state` when paused), `error`. One run per session at a time: a second `POST` while a run is active answers `409 run_in_progress`.

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

## Documentation

`docs/技术方案.md` §12, `docs/模块盘点/server.md`, `README.md` at the repository root ("Security notes") — in Chinese unless noted.

MIT © 2026 NewRate Limited.
