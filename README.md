# reins

**Hand the reins to the model.**

reins is an embeddable agent library. Install it, plug in your own model, and you get an agent that knows how to drive a long task: it sees its own context, decides when to tidy it, never loses the constraints you pinned, hands off to a fresh session with a proper summary, remembers what matters, and leaves a timeline you can replay and fork at any point.

The loop is a few hundred lines you can read and copy. Nothing is hidden. Every part is removable. The core runs on any runtime that speaks Web standards: Node, Bun, Deno, Cloudflare Workers, Vercel.

## Two principles

1. **Decisions default to the model.** The model is a capable colleague, not a process to be managed. The library does four things and nothing more: let it *see* (perception), give it *means* (tools), give it *bounds* (budgets, permissions, safety nets), and *record* everything (the timeline). It does not decide on the model's behalf.
2. **The timeline is the single source of truth; roles are a translation.** Everything that happens is one ordered timeline of events with an actor: user, model, tool, system, host. The model reads what actually happened, in order. Interrupting, inserting, changing your mind is just another event. Provider role formats are a lossy lowering at the edge, and every loss is declared.

## Status

Pre-alpha. Under construction. See `docs/` once published.

## Try it

```bash
pnpm install && pnpm build
ANTHROPIC_API_KEY=… node examples/minimal/server.ts   # then open http://localhost:8787
```

`examples/minimal/agent.ts` is the whole five-minute experience: one model, two tools (one needs approval), an in-memory store, and a Web-standard handler you can drop into any route.

Replay a recorded session without a key — the timeline is the only source of truth, so a JSONL of events is enough to rebuild what happened and what the model saw on every turn:

```bash
node examples/minimal/replay.ts examples/minimal/recordings/weather-deploy.jsonl --html /tmp/replay.html
```

## Packages

| package | what |
| --- | --- |
| `@reins/core` | event timeline, store interfaces, projection, loop, run state, socket, replay |
| `@reins/brain` | perception, compact, pins, spill, handoff, memory, approval, budget |
| `@reins/lowering-pi` | provider lowering on top of pi-ai |
| `@reins/server` | Web-standard `(Request) => Response` handler, SSE, replay from `lastSeq`; `./node` adapter |
| `@reins/store-sqlite` | SQLite-backed stores; one SQL layer, driver from the runtime (`node:sqlite`, `bun:sqlite`) |
| `@reins/store-pg` | Postgres-backed stores; any `query(text, params)` client (pg, PGlite) |
| `@reins/eval` | Eval harness: fixtures from event logs, recorded-tool replay, metrics, arm-vs-arm runner, the P8 gate |
| `@reins/ui-agui` | timeline events → AG-UI protocol events; minimal demo page |
| `reins` | `createAgent()` plus re-exports of core / server / ui-agui |

## Security notes

Read these before putting `@reins/server` on a public route.

**Session access is not authorized by default.** The handler identifies a session by `sessionId`
alone — a `GET ?sessionId=…` replays that session's entire timeline, and a `POST` with someone
else's `sessionId` continues their run. The `principal(request)` hook resolves *who is asking*,
but it does not decide *what they may touch*. If more than one user shares a handler, you must
also pass `authorizeSession`:

```ts
createAgentHandler(agent, {
  principal: (req) => verifyToken(req.headers.get("authorization")),
  // called after sessionId is parsed, before any of that session's log is read or written
  authorizeSession: async ({ sessionId, principal, method, isNew }) => {
    if (principal === undefined) throw new Response("unauthorized", { status: 401 })
    if (isNew) return true            // brand-new session: record the owner yourself, then allow
    return await ownsSession(principal.id, sessionId)
  },
})
```

Only an explicit `true` allows the request. `false` — or `undefined`, which is what a branch
with a missing `return` produces — answers `404 not_found` rather than `403`, because a `403`
would confirm that the session exists. Throwing a `Response` returns it verbatim, same as
`principal`. The hook is fail-closed on purpose: a forgotten `return` should lock you out
loudly, not wave a stranger through quietly.

**Runtime footprint.** `@reins/core` and `@reins/brain` have zero external dependencies.
`@reins/lowering-pi` pulls `pi-ai`, which declares ten dependencies of its own — installing it
fetches roughly 65 MB, of which about 29 MB (`@google/genai`, the AWS Bedrock SDK) is outside
the import graph reins actually reaches. Nothing Node-specific ends up on the paths we use:
the lowering layer is verified on Cloudflare workerd with no `nodejs_compat` flag
(see `spikes/edge-runtime-check`). If the install size matters more than provider coverage,
a zero-dependency lowering layer is on the roadmap.

**Session ids are validated.** A `sessionId` must be non-empty printable ASCII with no spaces;
anything else is answered `400 bad_request` on both `GET` and `POST`. The handler echoes the id
in the `X-Reins-Session` response header, and an out-of-range value would make `new Response(...)`
throw rather than return — a CRLF in there is refused by the runtime, so this was never an
injection hole, but it did turn a bad request into an unhandled exception. Note that `sessionId`
arrives from the client (query string on `GET`, body on `POST`), so this is input validation,
not a constraint on what you may name things. uuid, nanoid, hex and composite ids like
`user:42/sess-7` all pass.

## License

MIT
