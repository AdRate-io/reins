# @reinsjs/tools-mcp

Plug an [MCP](https://modelcontextprotocol.io) server into a reins agent as one `Socket`. Every tool the server
lists becomes a reins `Tool`; the loop, the brain modules (spill, approval, budget, compact…) and the timeline treat
them exactly like in-process tools. The server never learns that reins exists.

```ts
import { httpTransport, mcpTools } from "@reinsjs/tools-mcp"
import { approval, spill } from "@reinsjs/brain"
import { createAgent } from "@reinsjs/agent"

const github = mcpTools({
  transport: httpTransport({
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` },
  }),
})

export const agent = createAgent({
  model,
  store,
  tools: [myInProcessTool],
  sockets: [github, spill(), approval()],
})
```

Node-only stdio servers (a subprocess speaking JSON-RPC over stdin/stdout) live behind the `/node` entry:

```ts
import { stdioTransport } from "@reinsjs/tools-mcp/node"

const files = mcpTools({
  transport: stdioTransport({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"] }),
  prefix: "fs_",
})
```

The main entry uses only Web-standard APIs (`fetch`, `URL`, `Headers`) and runs on Cloudflare Workers without
`nodejs_compat` (verified on a 2023 compatibility date, see `spikes/edge-runtime-check`), and on Bun, Deno
(`--allow-net` is enough) and Vercel's `edge-runtime` (`spikes/runtime-matrix` — `tools/list` + `tools/call`
against a local server in each). Only `/node` imports `node:*`.

## What happens at run time

**Tools are bound per run.** When a run starts, the socket calls `tools/list` once and turns the result into the
run's tool table. The table does not change until the run ends — a `notifications/tools/list_changed` from the
server only affects the *next* run. This is deliberate: a stable tool table is what keeps prompt caches warm, and it
is where reins' "no dynamic registration" stance lands. The loop records the table in a `core.tools_bound` event
(invisible to the model) and, when it differs from the previous run's, appends a visible `system_note` naming the
added and removed tools so the model knows its hands changed.

**Calls go through `tools/call`.** The result's `content` blocks become reins content parts (text, images and audio as-is;
embedded binary resources become image / video / audio parts by mime type; resource links and other binary
resources become one-line descriptions — lossy, and said so). An image, as a block or an embedded resource, whose
type is not `image/jpeg`, `image/png`, `image/gif` or `image/webp` (an SVG chart, a TIFF) becomes the sentence
`unsupportedImageText` from `@reinsjs/core` instead: providers reject other types. MCP carries no duration, so video and audio are
estimated from their byte size, and whether the model actually sees them depends on the lowering's `video` /
`audio` capabilities (a placeholder otherwise). `isError` passes
through. A thrown error (unknown tool, dropped connection, timeout) becomes a `tool_result` with `isError: true`;
the run continues and the model decides what to do.

**Annotations set defaults, not permissions.** `readOnlyHint` → `risk: "low"`; `destructiveHint` → `risk: "high"` and
`needsApproval: true`; anything else (including no annotations) → `risk: "medium"`. The MCP spec says annotations are
hints and that untrusted servers' annotations must not drive authorization — so reins only uses them to *default*
the fields that `@reinsjs/brain`'s `approval()` policies read, and `override` lets the host change any of it:

```ts
mcpTools({
  transport,
  override: (tool, info) => {
    if (info.name === "delete_repo") return false // never expose this one
    if (info.annotations?.openWorldHint) return { ...tool, needsApproval: true }
    return undefined // keep the default translation
  },
})
```

Note the spec's own default for `destructiveHint` is `true` when absent. reins does not treat "unannotated" as
"destructive" — that would put every tool of every casual server behind an approval prompt. If you want that
strictness, add it in `override` or run `approval({ unmatched: "ask" })`.

## Connection lifecycle

`mcpTools()` does not connect. The first run that needs the tool table opens the connection; later runs reuse it.
If the transport closes (server restarted, network dropped), or a stateful Streamable HTTP server answers 404 because
the session it issued is gone (restart, session expiry), the next call that needs it — a `tools/call` in the
same run or `tools/list` at the next run start — rebuilds the connection from the transport recipe once. A `tools/list`
that hits the 404 re-initializes and lists again within the same call (it is read-only); a `tools/call` that hits it is
reported as an error and is not resent. Other calls already in flight on the expired connection are left to finish
before it is closed. If the run is stopped while a `tools/call` is still waiting for that rebuild, the call is never
sent and the model is told so (`ROUTE_NOT_SENT_TEXT`, the same text routed calls use), not that its outcome is
unknown. There is no retry policy inside a call: a failed call is reported to the model as an error result, and a
failed reconnect at run start throws before anything is written to the log (fail-closed). Pass `optional: true` to
instead start the run without that server's tools and warn once; the model then sees them listed as removed.

Call `close()` when you are done with a socket (process shutdown, or the host replaced the configuration). With
`route`, `evict(key)` retires one credential's connection; see [Several credentials on one server](#several-credentials-on-one-server).

Hosts that build the agent per request should **cache sockets by configuration**, not rebuild them every time:
rebuilding forces a fresh MCP handshake per request. `examples/mcp/agent.ts` shows a small cache keyed by the
server's config JSON, closing sockets whose config disappeared.

## Hot reload without restarts

There is no reload API because none is needed. `createAgent()` only assembles objects, and the tool table is
resolved at run start. A platform that stores each user's MCP servers in a database reads that configuration
when a request arrives, builds (or fetches from cache) the matching `mcpTools()` sockets, and runs. A server
added or removed by the user takes effect on their next message; the loop tells the model what changed.

One consequence to know about: a run paused for approval is signed with the tool table it had. If the
configuration changes while it is paused, resuming is rejected as configuration drift (`RunStateError`
`config_mismatch`). Hosts have three honest options: wait for the session to finish before applying the change,
accept that the paused run is abandoned and start a new one, or pass `allowConfigDrift: true` to resume anyway —
that resume also emits the tool-change note. What the library will not do is silently resume with a different
tool table than the one the approver saw.

## Expiring credentials

A fixed token can live in `headers`. A token that expires cannot: `headers` is fixed when the transport is built,
while the connection is created lazily, reused across runs and rebuilt from the same recipe after a drop — so once
the token expires, even the rebuild carries the stale one. Pass `auth` instead:

```ts
httpTransport({
  url: "https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer",
  auth: {
    token: () => db.accessToken(userId),          // called before every request
    onUnauthorized: () => db.refresh(userId),     // called on 401, then the request is retried once
  },
})
```

`auth` and an `Authorization` header are mutually exclusive — passing both throws at construction time rather than
letting one silently win.

`McpAuth` is deliberately these two methods and nothing more, and it does not reference any MCP SDK type. It is not
the SDK's `OAuthClientProvider`: the valuable part of that interface is driving a browser authorization prompt,
which a server-side agent cannot do. Obtain and store the tokens in your web application; the loop only reads and
refreshes them. Full OAuth flows are still not wrapped — call the SDK's `refreshAuthorization` (or your own code)
from inside `token` / `onUnauthorized`.

One user with several credentials on the same server (several identities, same catalog) is a different shape:
see the next section.

## Several credentials on one server

One user may hold several identities on the same server: several TikTok for Business authorizations, each a
separate OAuth token, each seeing the same tool catalog but a different set of ad accounts. The model should only
decide *what to do to which account*; which identity carries the call is an authorization rule, and it belongs to
the host. Pass `route`:

```ts
import { httpTransport, type McpRoute, type McpTransport, mcpTools } from "@reinsjs/tools-mcp"

/** Calls that touch no account. Only these run on the catalog identity. */
const NO_ACCOUNT = new Set(["tool_list", "tool_get"])

/** Every argument that names an account. TikTok's gateway tool nests them under `params`. */
const accountsOf = (name: string, args: unknown): string[] => {
  const top = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>
  const inner = name === "tool_execute" ? top.params : top
  const fields = (typeof inner === "object" && inner !== null ? inner : {}) as Record<string, unknown>
  return ["advertiser_id", "bc_id"]
    .map((field) => fields[field])
    .filter((id) => typeof id === "string" || typeof id === "number")
    .map(String)
}

interface Identities {
  /** The identity used for tools/list and for calls that touch no account */
  catalog: string
  /** Which identity may act on this account for this person; undefined when none may */
  forAccount(account: string, principalId: string | undefined): Promise<string | undefined>
  transport(identity: string): McpTransport
}

const routeByAccount = (ids: Identities): McpRoute => ({
  async keyOf({ name, args }, ctx) {
    if (NO_ACCOUNT.has(name)) return ids.catalog
    const accounts = accountsOf(name, args)
    if (accounts.length === 0) throw new Error(`Cannot tell which account ${name} acts on`)
    const chosen = new Set<string>()
    for (const account of accounts) {
      const identity = await ids.forAccount(account, ctx.principal?.id)
      if (identity === undefined)
        throw new Error(`No connected TikTok identity can access account ${account}`)
      chosen.add(identity)
    }
    if (chosen.size > 1)
      throw new Error(`Accounts ${accounts.join(", ")} need different identities; use one per call`)
    return [...chosen][0] as string
  },
  transportFor: (identity) => ids.transport(identity),
})

// ids.transport(identity) = httpTransport({ url, auth: { token: () => db.accessToken(identity), onUnauthorized: … } })
const tiktok = mcpTools({ transport: ids.transport(ids.catalog), route: routeByAccount(ids) })
```

What happens:

- `transport` is still the **catalog connection**: `tools/list` runs on it once at run start, and `optional`
  applies to it alone. The tool table, and therefore the config hash, does not depend on `route`, so changing the
  routing rules never counts as configuration drift. The identities are assumed to see the same catalog; when one
  lacks a tool, the server's error reaches the model as an error result.
- Every `tools/call` first asks `keyOf`. The returned key picks a connection from a pool owned by the socket;
  a new key calls `transportFor(key)` once and the connection then follows the usual lifecycle (lazy, reused
  across runs, rebuilt once after a drop). Each key's recipe carries its own `auth`, so a 401 refreshes that
  identity alone.
- `keyOf` returning anything but a non-empty string, or throwing, means the call is **not sent** — never sent on
  the catalog connection instead. A thrown message reaches the model verbatim, so write it for the model.
- If the run is stopped while the call is still being routed (inside `keyOf`, `transportFor` or a new key's
  handshake), the model is told the call was not executed (`ROUTE_NOT_SENT_TEXT`), not that its outcome is unknown.
- Call `evict(key)` when a credential is revoked, expires or gets a new recipe. The key leaves the pool at once;
  its connection closes after the calls in flight on it finish, so a write that already reached the server is not
  cut off and reported as a failure. `close()` does not wait: it closes everything, evicted connections included.

Things you are responsible for:

- **`keyOf` is the only authorization point.** The pool is keyed by credential only, and a cached socket is shared
  by every session and user that reaches it. Check in `keyOf` that `ctx.principal` may use that identity. Fail
  closed the way the recipe does: only an explicit list of account-free tools may use the catalog identity, a call
  whose account you cannot find is refused rather than sent on some default identity, and every argument that
  names an account must resolve to the same identity. Extend `accountsOf` with every account-naming argument your
  server has.
- **`transportFor` must depend on the key alone.** It runs once per key, not once per call, so anything
  request-specific it captured would leak to later callers.
- **Approval happens before routing.** The approver does not see which identity will carry the call unless you
  compute it in the approval rule's `summary` with the same function.
- **The catalog credential cannot be evicted on its own.** If it is revoked, `close()` the socket and build a new
  one (the pool goes with it and is rebuilt on demand).
- Each pooled connection keeps a standing SSE stream open once initialized (MCP SDK behaviour). The pool has no
  size limit; it holds as many connections as there are keys you route to until you evict them.

`packages/tools-mcp/src/multi-credential.recipe.test.ts` is the executable version of this recipe.

## Gateway-style servers

Some servers put hundreds of operations behind **one** dispatching tool. TikTok for Business is the current
example: its layered endpoint registers 41 ordinary tools plus `tool_list` / `tool_get` / `tool_execute`, and the
other ~330 operations live only in a server-side registry, reached through `tool_execute({ tool_name, params })`.

This costs the loop nothing — the tool table is fixed for the whole run, so the prompt-cache prefix and config hash
are unaffected. **But it silently defeats approval policies written against tool names.** Creating a campaign,
changing a budget and deleting an asset group are all called `tool_execute`; what actually happens is in the
arguments.

```ts
// WRONG — this never matches. Every operation is named tool_execute.
approval({ deny: ["*_delete"], allow: ["*"] })

// RIGHT — decide on the operation name inside the arguments.
const operationOf = (args: unknown): string =>
  typeof args === "object" && args !== null && "tool_name" in args
    ? String((args as { tool_name?: unknown }).tool_name ?? "")
    : ""

approval({
  ask: [{
    id: "gateway.writes",
    match: (call) =>
      call.name === "tool_execute" && /_(create|update|delete|upload)$/.test(operationOf(call.args)),
    summary: (call) => `TikTok ${operationOf(call.args)}`,   // the approver sees the real operation
  }],
  allow: [
    { id: "gateway.reads", match: (call) =>
        call.name === "tool_execute" && /_(get|list|search)$/.test(operationOf(call.args)) },
    "tool_list",
    "tool_get",
  ],
})
```

The executable version of this recipe is `packages/brain/src/gateway-tool.recipe.test.ts`, including the negative
case that proves the name-based rule lets a delete through.

With no rules configured the default is safe but blunt: such a server declares no annotations, so the translated
tool carries no `risk`, and `unmatched: "byRisk"` sends **every** call — reads included — to a human. That is
fail-closed by design; open up the read path with the recipe above rather than by allowing the dispatcher wholesale.

Two more things worth knowing about servers of this shape:

- **A registry listing can be large.** TikTok's `tool_list` returns ~57 KB. Under `spill` that becomes a preview
  plus a `fetch_blob` handle — useless, because choosing a tool is exactly what the full listing is for. Raise the
  budget for that one tool: `override: (tool, info) => info.name === "tool_list" ? { ...tool, resultPolicy: { maxTokens: 100_000, overflow: "spill" } } : tool`.
- **Upstream business errors may not set `isError`.** TikTok returns `{"code": 40001, "message": "..."}` as a
  *successful* MCP result; only MCP-level failures (unknown tool, transport error) are `isError`. Anything keying
  off `isError` — retries, your own policies, `onEvent` observers — will not see those unless you translate them;
  the `withBusinessErrors` wrapper in the next section does exactly that.

## Large flat tool tables

The opposite shape: hundreds of ordinary tools, each annotated honestly. TikTok's flat endpoint lists 377 of them,
about 200 reads and 130 writes, every one with `readOnlyHint`. Two things you usually want there: keep the writes
out of the model's reach entirely (they go through your own tools, with your own authorization and audit trail),
and stop sending two hundred tool definitions on every request. Both are one `override` plus
`@reinsjs/brain`'s `lazyTools()`:

```ts
import { lazyTools } from "@reinsjs/brain"
import { normalizeToolOutput, type Tool, type ToolResult } from "@reinsjs/core"

/** TikTok puts business errors in a successful result: text = {"code": <non-zero>, "message": ...} */
const businessErrorOf = (result: ToolResult): string | undefined => {
  if (result.isError) return undefined
  for (const part of result.content) {
    if (part.type !== "text") continue
    try {
      const body = JSON.parse(part.text) as { code?: unknown; message?: unknown }
      if (typeof body.code === "number" && body.code !== 0)
        return `Upstream error ${body.code}: ${String(body.message ?? "")}`
    } catch {
      // not JSON, not an error envelope
    }
  }
  return undefined
}

/** Keep the original text for the model, but mark it as an error so retries, policies and observers see it */
const withBusinessErrors = (tool: Tool): Tool => ({
  ...tool,
  async execute(input, ctx) {
    const result = normalizeToolOutput(await tool.execute?.(input, ctx))
    const error = businessErrorOf(result)
    return error ? { content: [...result.content, { type: "text", text: error }], isError: true } : result
  },
})

/** reads: on the menu, loaded on demand; everything else: not a tool the model has */
const readOnlyLazy = (tool: Tool, info: McpToolInfo) =>
  info.annotations?.readOnlyHint === true ? withBusinessErrors({ ...tool, lazy: true }) : false

const tiktok = mcpTools({ transport, override: readOnlyLazy })

createAgent({ sockets: [tiktok, lazyTools()] }) // order matters — see below
```

`lazyTools()` builds its menu from the tools bound *before* it: the host's, plus those of every socket registered
earlier. So it goes after `mcpTools()`. The other order is not an error, just useless: the MCP tools are sent in
full every turn, and `lazyTools()` warns once, naming them. With a lowering layer that has a native place for
deferred tools (`@reinsjs/lowering-fetch` on Anthropic) loading a tool does not even re-warm the prompt cache; see
the brain README for the numbers.

Loaded definitions are trusted like the tools block itself (`tool_find` results are `trust: "system"`) — the
same descriptions were already going to the model unwrapped. A 200-line menu costs roughly 10k tokens of system
prompt; it sits in the cached prefix and does not change within a run, and `lazyTools({ summarize })` can shorten it.

The executable version of this recipe is `packages/tools-mcp/src/readonly-lazy.recipe.test.ts`, including the
wrong-order case.

## Verified upstream behaviour

Requests whose history contains `tool_use` / `tool_result` for a tool that is no longer in the tool table were
accepted by DeepSeek's Anthropic-protocol endpoint and by the OpenAI Responses protocol (both with another tool
present and with an empty tool table); the model answered and correctly listed only its current tools. So
removing a tool does not require a new session on those upstreams. Anthropic's own endpoint, reached through
Cloudflare AI Gateway's passthrough path, accepted both variants as well (2026-09-15, `spikes/l1-deferred-tools` P8);
an aggregator's Claude endpoint returned a truncated stream, a known quirk of that proxy rather than a protocol
rejection. Script: `spikes/mcp-removed-tool-history`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `transport` | — | `httpTransport({ url, headers?, auth?, fetch?, requestInit?, label? })` or `stdioTransport({ command, args?, env?, cwd?, stderr?, label? })` |
| `prefix` | none | Prepended to tool names shown to the model; the server still sees the original name |
| `callTimeoutMs` | 60 000 | Per `tools/call` timeout; expiry becomes an error result |
| `optional` | `false` | On `tools/list` failure at run start: throw (default) or contribute no tools and warn once |
| `override(tool, info)` | — | Per-tool rewrite; return `false` to drop the tool |
| `route` | — | `{ keyOf(call, ctx), transportFor(key) }`: pick a credential per `tools/call`; `transport` then serves `tools/list` only |
| `clientInfo` | `{ name: "reins", version }` | Sent in the MCP handshake |
| `warn` | `console.warn` | Where degradations are reported |

A transport's `label` names the socket (`mcp:<label>`) and appears in warnings and in connection errors — which can
reach the model as an error result and stay in the log. It therefore defaults to the parts that never carry a
secret: the URL's origin for HTTP (no path, no query) and the bare `command` for stdio (no arguments). Pass `label`
for a friendlier name, and keep secrets out of it. Several servers on one origin (`https://host/github` and
`https://host/slack`) would otherwise share a label, so give each its own `label` to tell their sockets and warnings apart.

Tool names that the model APIs reject (`^[A-Za-z0-9_-]{1,64}$`) are rewritten (`files.read` → `files_read`) with a
one-time warning; the original name is used on the wire. If a rewrite lands on a name another tool of the same
server already uses (`files.delete` next to `files_delete`, or two long names sharing their first 64 characters), the
rewritten one gets a `_2`, `_3`… suffix and the warning names the clash — names that need no rewrite keep theirs.
Suffixes are handed out in order of the original names, so a server listing its tools in a different order does
not change them. They are not stable across server changes, though: if the server adds a tool whose valid name
equals a rewritten one, the rewritten tool moves to a suffixed name. When you need the model-facing name (approval
rules, lazy-tool lists), take it from the `tool.name` that `override(tool, info)` receives, keyed by `info.name`;
the exported `modelToolName` rewrites a single name and does not know about clashes.

Not supported: sampling, elicitation, resources, prompts, MCP Apps, and driving an OAuth authorization
prompt (obtain tokens in your application and hand them over through `auth`).

## License

MIT © 2026 NewRate Limited.
