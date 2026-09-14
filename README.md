# reins

**Hand the reins to the model.**

reins is an embeddable agent library. Install it, plug in your own model, and you get an agent that knows how to drive a long task: it sees its own context, decides when to tidy it, never loses the constraints you pinned, hands off to a fresh session with a proper summary, remembers what matters, and leaves a timeline you can replay and fork at any point.

The loop is a few hundred lines you can read and copy. Nothing is hidden. Every part is removable. The core is written against Web standards only and is verified on Node 22 and Cloudflare Workers (strictest compat, no `nodejs_compat`); Bun, Deno and Vercel Edge should work but are not yet tested.

## Two principles

1. **Decisions default to the model.** The model is a capable colleague, not a process to be managed. The library does four things and nothing more: let it *see* (perception), give it *means* (tools), give it *bounds* (budgets, permissions, safety nets), and *record* everything (the timeline). It does not decide on the model's behalf.
2. **The timeline is the single source of truth; roles are a translation.** Everything that happens is one ordered timeline of events with an actor: user, model, tool, system, host. The model reads what actually happened, in order. Interrupting, inserting, changing your mind is just another event. Provider role formats are a lossy lowering at the edge, and every loss is declared.

## Status

**0.1.0** — first public release. Eleven packages, ~32k lines of TypeScript, 760 tests, every default measured on real models (see `examples/eval`). Public types are frozen for the 0.1 line; breaking changes bump the minor version until 1.0.

Design documents live in `docs/` and are written in Chinese; every package has an English README. Install with `pnpm add @reinsjs/agent @reinsjs/lowering-pi @reinsjs/brain` — Node ≥ 22 or Cloudflare Workers (tested); Bun / Deno / Vercel Edge untested.

## Try it

```bash
pnpm install && pnpm build && pnpm check:dist
ANTHROPIC_API_KEY=… node examples/minimal/server.ts   # then open http://localhost:8787
```

`examples/minimal/agent.ts` is the whole five-minute experience: one model, two tools (one needs approval), an in-memory store, and a Web-standard handler you can drop into any route.

Replay a recorded session without a key — the timeline is the only source of truth, so a JSONL of events is enough to rebuild what happened and what the model saw on every turn:

```bash
node examples/minimal/replay.ts examples/minimal/recordings/weather-deploy.jsonl --html /tmp/replay.html
```

Observing a run needs no hook in-process: `agent.run()` is an async generator that yields every event as it is appended, so `for await (const event of agent.run({ input }))` is the observer. Over HTTP the handler consumes that generator for you and exposes the same stream as `onEvent(event, { sessionId, principal, request })` — see `@reinsjs/server`'s README, "Observability".

## Packages

| package | what |
| --- | --- |
| `@reinsjs/core` | event timeline, store interfaces, projection, loop, run state, socket, replay |
| `@reinsjs/brain` | perception, compact, pins, spill, handoff, memory, approval, budget, skills, lazy-tools (`./node` has `fsSkillSource`) |
| `@reinsjs/lowering-pi` | provider lowering on top of pi-ai |
| `@reinsjs/server` | Web-standard `(Request) => Response` handler, SSE, replay from `lastSeq`; `./node` adapter |
| `@reinsjs/store-sqlite` | SQLite-backed stores; one SQL layer, driver from the runtime (`node:sqlite`, `bun:sqlite`) |
| `@reinsjs/store-pg` | Postgres-backed stores; any `query(text, params)` client (pg, PGlite) |
| `@reinsjs/eval` | Eval harness: fixtures from event logs, recorded-tool replay, metrics, arm-vs-arm runner, the P8 gate |
| `@reinsjs/ui-agui` | timeline events → AG-UI protocol events; minimal demo page |
| `@reinsjs/tools-mcp` | MCP servers as one socket: tools bound per run, annotations as defaults, `/node` stdio transport |
| `@reinsjs/adapter-tanstack-ai` | the brain as a TanStack AI chat middleware, the log stays the single source of truth |
| `@reinsjs/agent` | `createAgent()` and `asTool()` plus re-exports of core / server / ui-agui |

## Memory and how to isolate it

The `memory()` socket in `@reinsjs/brain` gives the model a `memory` tool shaped like Anthropic's
`memory_20250818` (view / create / str_replace / insert / delete / rename under `/memories`). What
to remember and when is the model's call; the library only decides *where the bytes go*. Isolation
is layered, and each layer has exactly one owner:

| layer | who decides | knob |
| --- | --- | --- |
| store instance — which table, which database | you, when you build the store | `sqliteStores(db, { memoryTable })`, `pgStores(client, { memoryTable })`, or any `MemoryStore` you implement |
| namespace prefix inside one store | you, per agent | `memory({ namespace: (ctx) => "/…" })` — prepended to the storage key, invisible to the model |
| paths under `/memories` | the model | none — it organizes its own files |

There is no "role" column anywhere. Which role is running is already decided by which
`createAgent` you called, so neither the events nor the storage learn about it. The three common
setups differ only in the namespace function.

**One shared memory for the whole platform** — every agent reads and writes the same `/memories`:

```ts
const store = await pgStores(pool)
const planner = createAgent({ model, store, sockets: [memory()], systemPrompt: "…" })
const analyst = createAgent({ model, store, sockets: [memory()], systemPrompt: "…" })
```

**One memory per role** — each agent closes over a constant prefix. They still share one table and
one event log:

```ts
const finance = createAgent({ model, store, sockets: [memory({ namespace: () => "/roles/finance" })] })
const legal   = createAgent({ model, store, sockets: [memory({ namespace: () => "/roles/legal" })] })
```

If roles must not even share a table (separate retention, separate backups, a per-role
`DROP TABLE`), move the split one layer down and give each role its own table in the same
database. Events and blobs stay shared and are isolated by `session_id`:

```ts
const financeStore = await pgStores(pool, { memoryTable: "finance_memory" })
const legalStore   = await pgStores(pool, { memoryTable: "legal_memory" })
```

**Per role, then per user** — append the principal your handler resolved for this request:

```ts
memory({ namespace: (ctx) => `/roles/finance/users/${ctx.principal?.id ?? "anonymous"}` })
```

Table names are checked against `^[A-Za-z_][A-Za-z0-9_]{0,62}$` before any SQL is assembled; an
invalid name throws `invalid_argument` and touches nothing. Shared read-only knowledge is what
`skills()` in `@reinsjs/brain` is for (the same store can serve `/skills` and `/memories`); mounting two
*writable* memory namespaces into one agent is not supported yet, see `docs/技术方案.md` §9.6.

## Security notes

Read these before putting `@reinsjs/server` on a public route.

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

**Memory is shared unless you namespace it.** `authorizeSession` isolates timelines, not the memory store: `memory()` writes to `/memories/...` for everyone by default. In a multi-tenant deployment pass `memory({ namespace: (ctx) => `/users/${ctx.principal?.id}` })` (or a per-role `memoryTable` on the store, see "Memory and how to isolate it" above) — otherwise one user's model can read what another user's model wrote.

**Runtime footprint.** `@reinsjs/core` and `@reinsjs/brain` have zero external dependencies.
`@reinsjs/lowering-pi` pulls `pi-ai`, which declares ten dependencies of its own — installing it
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

MIT © 2026 NewRate Limited
