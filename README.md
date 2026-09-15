# reins

**Hand the reins to the model.**

reins is an embeddable agent library. Install it, plug in your own model, and you get an agent that knows how to drive a long task: it sees its own context, decides when to tidy it, never loses the constraints you pinned, hands off to a fresh session with a proper summary, remembers what matters, and leaves a timeline you can replay and fork at any point.

The loop is a few hundred lines you can read and copy. Nothing is hidden. Every part is removable. The core is written against Web standards only and is verified on Node 22, Cloudflare Workers (strictest compat, no `nodejs_compat`), Bun, Deno and Vercel's Edge Runtime — the same built artifacts, the same probes, every cell checked on content (`spikes/edge-runtime-check`, `spikes/runtime-matrix`).

## Two principles

1. **Decisions default to the model.** The model is a capable colleague, not a process to be managed. The library does four things and nothing more: let it *see* (perception), give it *means* (tools), give it *bounds* (budgets, permissions, safety nets), and *record* everything (the timeline). It does not decide on the model's behalf.
2. **The timeline is the single source of truth; roles are a translation.** Everything that happens is one ordered timeline of events with an actor: user, model, tool, system, host. The model reads what actually happened, in order. Interrupting, inserting, changing your mind is just another event. Provider role formats are a lossy lowering at the edge, and every loss is declared.

## Status

**0.1.0** — first public release. Eleven packages, ~32k lines of TypeScript, 760 tests, every default measured on real models (see `examples/eval`). Public types are frozen for the 0.1 line; breaking changes bump the minor version until 1.0.

Design documents live in `docs/` and are written in Chinese; every package has an English README. Install with `pnpm add @reinsjs/agent @reinsjs/lowering-fetch @reinsjs/brain` (or `@reinsjs/lowering-pi` for the pi-ai-based lowering layer; see "Choosing between" in `@reinsjs/lowering-fetch`'s README) — Node ≥ 22 or Cloudflare Workers (tested); Bun / Deno / Vercel Edge untested.

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
| `@reinsjs/lowering-fetch` | zero-dependency provider lowering on `fetch`: OpenAI Chat Completions, Anthropic Messages, OpenAI Responses |
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

## Redacting what reaches the log

The event log is the only source of truth, so anything you do not want persisted has to be
cleaned *before* it is appended. There is no redaction option in the library — a regex that is
right for your data is wrong for the next person's — but there are exactly two places where
content enters the log, and each has a hook already.

**Tool results: the `afterTool` draft.** Every server-side tool result passes through the
`afterTool` hook of each socket, in socket order, before it is appended. Return a new draft and
that is what gets logged. Put this socket **first** in `sockets`, so `spill()`, `compact()` and
`pins()` only ever see the cleaned text — `spill()` in particular copies oversized results into
the `BlobStore` from this same draft:

```ts
import type { ContentPart, Socket } from "@reinsjs/core"

const redact = (text: string) =>
  text.replace(/\b\d{16}\b/g, "[card]").replace(/sk-[A-Za-z0-9]{8,}/g, "[token]")

const redactParts = (parts: ContentPart[]): ContentPart[] =>
  parts.map((p) => (p.type === "text" ? { ...p, text: redact(p.text) } : p))

const redactingTool: Socket = {
  name: "redact",
  afterTool: (_ctx, _call, result) => ({
    ...result,
    payload: { ...result.payload, content: redactParts(result.payload.content) },
  }),
}

createAgent({ model, store, sockets: [redactingTool, spill(), compact()] })
```

The model and the log see the same cleaned result: `afterTool` edits the one draft both of them
get. This also covers the TanStack adapter, which runs the same hook.

**Everything else: wrap `append`.** User messages, the model's own text, client-side tool results
the host fills in over `POST`, and events emitted by brain modules do not pass through
`afterTool`. They all pass through `EventLog.append`, so wrap the log you hand to the store.
Only writes are intercepted; `read`, `tail` and `fork` pass straight through, and the store never
holds the original:

```ts
import type { CoreEvent, Event, EventLog } from "@reinsjs/core"

function redactingLog(log: EventLog): EventLog {
  const clean = (e: Event): Event => {
    const c = e as CoreEvent
    switch (c.type) {
      case "core.user_message":
      case "core.tool_result":
        return { ...c, payload: { ...c.payload, content: redactParts(c.payload.content) } } as Event
      case "core.model_text":
        return { ...c, payload: { ...c.payload, text: redact(c.payload.text) } } as Event
      default:
        return e
    }
  }
  return {
    append: (events) => log.append(events.map(clean)),
    read: (sessionId, opts) => log.read(sessionId, opts),
    tail: (sessionId, n) => log.tail(sessionId, n),
    fork: (from, at, to) => log.fork(from, at, to),
  }
}

const store = await pgStores(pool)
createAgent({ model, store: { ...store, log: redactingLog(store.log) }, sockets: [redactingTool, …] })
```

Two boundaries to know. The wrapper cleans what is *stored*, and — because the loop re-reads the
timeline from the log every turn — what the *model* sees from the next request on, in the same run.
It does not clean the event objects the loop yields: `agent.run()` consumers, the SSE stream and
`onEvent` receive the object the loop built before it reached the wrapper. If the stream must be
clean too, redact the `input` before it enters the loop (or once more in your encoder / `onEvent`).
And the two hooks are not interchangeable: a tool result redacted only in the wrapper is already
in the `BlobStore` in full if `spill()` moved it there — the `afterTool` socket is what keeps blobs
clean, the wrapper is what keeps everything else clean. Both recipes are exercised in
`packages/brain/src/redaction.recipe.test.ts`, including the "wrong order leaks into the blob" case.

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

**One instance is not many.** The "one run per session" guard (`409 run_in_progress`) is kept in an in-process registry by default. Behind a load balancer, two instances can both start a run on the same session; the second wastes a model call and then hits `seq_conflict` — the log stays correct, the call does not. Share a `RunLease` through the store to make the guard span processes: `pgStores()` provides one and `createAgent` installs it automatically; with `@reinsjs/server` directly, pass `runs: leasedRunRegistry(store.runLease)`. A `GET` reconnect that lands on another instance replays the log and ends — use sticky sessions for a live tail.

**Memory is shared unless you namespace it.** `authorizeSession` isolates timelines, not the memory store: `memory()` writes to `/memories/...` for everyone by default. In a multi-tenant deployment pass `memory({ namespace: (ctx) => `/users/${ctx.principal?.id}` })` (or a per-role `memoryTable` on the store, see "Memory and how to isolate it" above) — otherwise one user's model can read what another user's model wrote.

**Runtime footprint.** `@reinsjs/core`, `@reinsjs/brain` and `@reinsjs/lowering-fetch` have zero
external dependencies. `@reinsjs/lowering-pi` pulls `pi-ai`, which declares ten dependencies of its
own — installing it fetches roughly 65 MB, of which about 29 MB (`@google/genai`, the AWS Bedrock SDK)
is outside the import graph reins actually reaches. Nothing Node-specific ends up on the paths we use:
both lowering layers are verified on Cloudflare workerd with no `nodejs_compat` flag and a 2023
`compatibility_date`, each protocol against a live provider (see `spikes/edge-runtime-check`), and on
Bun 1.4, Deno 2.9 and Vercel's `edge-runtime` with the same probes (`spikes/runtime-matrix`). Two runtime
notes for `lowering-pi`: on Deno, pi-ai's user-agent string reads `os.release()`, so grant
`--allow-sys=osRelease` (`lowering-fetch` needs only `--allow-net`); on an Edge runtime the `openai` SDK
expects a `process` global to exist (Vercel's deployed Edge runtime has one — verified with a live deployment; the bare local emulator does not).
On Bun, raise `Bun.serve({ idleTimeout })` above its 10-second default or a slow model call is cut off.

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
