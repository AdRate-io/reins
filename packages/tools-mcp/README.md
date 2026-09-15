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

**Calls go through `tools/call`.** The result's `content` blocks become reins content parts (text and images as-is;
audio, resource links and binary resources become one-line descriptions — lossy, and said so). `isError` passes
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
If the transport closes (server restarted, network dropped), the next call that needs it — a `tools/call` in the
same run or `tools/list` at the next run start — rebuilds the connection from the transport recipe once. There is
no retry policy inside a call: a failed call is reported to the model as an error result, and a failed reconnect at
run start throws before anything is written to the log (fail-closed). Pass `optional: true` to instead start the
run without that server's tools and warn once; the model then sees them listed as removed.

Call `close()` when you are done with a socket (process shutdown, or the host replaced the configuration).

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
  off `isError` — retries, your own policies — will not see those. The model reads the code from the JSON.

## Verified upstream behaviour

Requests whose history contains `tool_use` / `tool_result` for a tool that is no longer in the tool table were
accepted by DeepSeek's Anthropic-protocol endpoint and by the OpenAI Responses protocol (both with another tool
present and with an empty tool table); the model answered and correctly listed only its current tools. So
removing a tool does not require a new session on those upstreams. Anthropic's own endpoint was not tested
directly (no key); an aggregator's Claude endpoint returned a truncated stream, a known quirk of that proxy rather
than a protocol rejection. Script: `spikes/mcp-removed-tool-history`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `transport` | — | `httpTransport({ url, headers?, auth?, fetch?, requestInit? })` or `stdioTransport({ command, args?, env?, cwd?, stderr? })` |
| `prefix` | none | Prepended to tool names shown to the model; the server still sees the original name |
| `callTimeoutMs` | 60 000 | Per `tools/call` timeout; expiry becomes an error result |
| `optional` | `false` | On `tools/list` failure at run start: throw (default) or contribute no tools and warn once |
| `override(tool, info)` | — | Per-tool rewrite; return `false` to drop the tool |
| `clientInfo` | `{ name: "reins", version }` | Sent in the MCP handshake |
| `warn` | `console.warn` | Where degradations are reported |

Tool names that the model APIs reject (`^[A-Za-z0-9_-]{1,64}$`) are rewritten (`files.read` → `files_read`) with a
one-time warning; the original name is used on the wire.

Not supported: sampling, elicitation, resources, prompts, MCP Apps, and driving an OAuth authorization
prompt (obtain tokens in your application and hand them over through `auth`).

## License

MIT © 2026 NewRate Limited.
