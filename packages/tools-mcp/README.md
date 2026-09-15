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
| `transport` | — | `httpTransport({ url, headers?, fetch?, requestInit? })` or `stdioTransport({ command, args?, env?, cwd?, stderr? })` |
| `prefix` | none | Prepended to tool names shown to the model; the server still sees the original name |
| `callTimeoutMs` | 60 000 | Per `tools/call` timeout; expiry becomes an error result |
| `optional` | `false` | On `tools/list` failure at run start: throw (default) or contribute no tools and warn once |
| `override(tool, info)` | — | Per-tool rewrite; return `false` to drop the tool |
| `clientInfo` | `{ name: "reins", version }` | Sent in the MCP handshake |
| `warn` | `console.warn` | Where degradations are reported |

Tool names that the model APIs reject (`^[A-Za-z0-9_-]{1,64}$`) are rewritten (`files.read` → `files_read`) with a
one-time warning; the original name is used on the wire.

Not in 0.1: sampling, elicitation, resources, prompts, MCP Apps, OAuth flows (bring your own `fetch` or
`headers`).

## License

MIT © 2026 NewRate Limited.
