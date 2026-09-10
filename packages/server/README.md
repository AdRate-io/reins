# @reins/server

A Web-standard `(Request) => Promise<Response>` handler around the [reins](../../README.md) loop. `POST` starts or resumes a run and streams the timeline as SSE (`id:` = event `seq`); `GET` replays from `lastSeq` and joins a run in progress. No framework, no private runtime dependency — the same file serves Node, Bun, Deno and Cloudflare Workers.

```bash
pnpm add @reins/server
```

```ts
import { createAgentHandler } from "@reins/server"

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
import { nodeListener } from "@reins/server/node"
createServer(nodeListener(handler)).listen(8787)
```

The umbrella package `reins` wraps this as `createAgent(...).handler` with the AG-UI encoder as default; used directly, this package streams raw timeline events (`rawEncoder`).

## Protocol

| request | body / query | behaviour |
| --- | --- | --- |
| `POST` | `{ input }` | new session, id returned in the `start` frame and the `X-Reins-Session` header |
| `POST` | `{ sessionId, input }` | continue a session |
| `POST` | `{ sessionId, resume, decisions }` | resume a paused run with approval decisions (`resume` is the `state` from the previous `result` frame; a decision for a sub-agent's call carries `sessionId: childSessionId`) |
| `POST` / `GET` | `lastSeq` | replay `(lastSeq, tail]` first, then continue live |

Frames: `start`, one frame per event, `delta` (optional streaming increments), `result` (the `RunResult`, including a signed `state` when paused), `error`. One run per session at a time: a second `POST` while a run is active answers `409 run_in_progress`.

## Security defaults

- **`authorizeSession` is not optional in multi-tenant deployments.** Without it, anyone who knows a `sessionId` can read that timeline and continue that run. Only an explicit `true` allows; `false` or `undefined` answers `404` (not `403`, which would confirm the session exists).
- **Input is whitelisted twice.** A `POST` body's `input` may be text, content parts, or a draft of type `core.user_message` / `core.tool_result` / `core.system_note` / `ext.*`. Anything else — notably a forged `approval_decision` — is refused here and again inside the loop.
- **Resume is validated before anything is written.** Signature (when `secret` is set), configuration hash, and the digest of pending tool calls must match the log; drift answers `409 config_mismatch` unless the host passes `allowConfigDrift`.
- **Session ids** must be non-empty printable ASCII without spaces (`400` otherwise).
- Failures after the stream has opened arrive as a `200` with an `error` frame, and the run slot is released so the session does not stay `409` forever.

## Options

| option | default | meaning |
| --- | --- | --- |
| `encode` | raw events | `StreamEncoderFactory`; `aguiEncoding()` from `@reins/ui-agui` |
| `deltas` | `true` | forward streaming text/thinking deltas as `delta` frames |
| `heartbeatMs` | 15 000 | SSE comment heartbeat; `0` disables |
| `onDisconnect` | `"continue"` | or `"abort"` the run when the client goes away |
| `principal(req)` | — | who is asking; passed to the loop and tools |
| `authorizeSession(input)` | — | whether they may touch this session (see above) |

## Documentation

`docs/技术方案.md` §12, `docs/模块盘点/server.md`, `README.md` at the repository root ("Security notes") — in Chinese unless noted.

MIT.
