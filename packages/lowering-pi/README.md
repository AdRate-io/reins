# @reinsjs/lowering-pi

The lowering layer for [reins](../../README.md) built on [pi-ai](https://github.com/badlogic/pi-mono): timeline events → provider messages → Anthropic Messages or OpenAI Responses wire protocol, and streaming responses → event drafts. Every event type has a declared landing per API (`LOSS_MATRIX`: exact, lossy, dropped); nothing is dropped silently.

```bash
pnpm add @reinsjs/lowering-pi
```

```ts
import { anthropic, openai } from "@reinsjs/lowering-pi"
import { createAgent } from "@reinsjs/agent"

const claude = anthropic("claude-opus-5", { apiKey: process.env.ANTHROPIC_API_KEY! })
const gpt = openai("gpt-5.5", { apiKey: process.env.OPENAI_API_KEY!, baseUrl: "https://gateway.example/v1" })

export const agent = createAgent({ model: claude, store, tools })
```

`anthropic()` / `openai()` return a `BoundModel = { model, lowering }` — the only thing `createAgent` needs. The `apiKey` is a required option, never read from the environment, so the same code runs where there is no `process.env`.

## Options

| option | meaning |
| --- | --- |
| `apiKey` | required |
| `baseUrl` | gateway or proxy; both factories accept any endpoint speaking the respective protocol (DeepSeek's Anthropic-compatible endpoint is tested) |
| `requestOptions` | passed to pi-ai **as a whole, not merged** — if you set it on `openai()`, include `reasoningEffort` yourself or reasoning turns off |
| `contextWindow`, `maxOutputTokens`, `reasoning`, `images`, `midConversationSystem` | override the capability table (`capabilitiesOf`) for models the table does not know |
| `trustMarkers` | default on: tool output is wrapped in `<untrusted source="tool:…">` in the request (the log keeps the original) |

## How events land

- Model roles exist only here. `system_note` events become `system` blocks where the API allows mid-conversation system content, otherwise a framed `user` message (declared lossy).
- A user message that arrives while tool results are still pending is moved after them on the wire (Anthropic requires `tool_result` right after `tool_use`) and recorded as `lossy(user)`; the log order is untouched.
- Thinking blocks are replayed only with a signature from the same provider and model.
- Anthropic cache breakpoints: at most four block-level breakpoints are set; when they are exhausted the top-level breakpoint is silently skipped rather than producing a 400.
- pi-ai 0.85.1 has no `system` role for injected content; the layer rewrites the payload in pi-ai's `onPayload` hook. The `LoweredRequest.payload` you can inspect shows the pre-rewrite shape — remember that when debugging a 400.

## Runtime footprint

pi-ai declares ten dependencies (≈65 MB installed, about 29 MB of which reins never imports). Nothing Node-specific is on the paths used here; the layer is verified on Cloudflare workerd without `nodejs_compat`, and on Bun, Deno and Vercel's `edge-runtime` (`spikes/runtime-matrix`). Two runtime caveats inherited from upstream: pi-ai builds its user-agent from `os.release()`, so Deno needs `--allow-sys=osRelease`; the `openai` SDK's edge branch reads `process.version` unguarded, so an Edge runtime must expose a `process` object (Vercel does via `process.env`; the bare `edge-runtime` emulator does not). If install size matters more to you than getting the provider table through pi-ai, use [`@reinsjs/lowering-fetch`](../lowering-fetch/README.md) — the same `Lowering` interface with no dependency but `@reinsjs/core`, three wire protocols (it adds OpenAI Chat Completions), and a request body that is sent exactly as you inspect it. Its README has a side-by-side comparison; timelines written by one layer replay through the other.

## Documentation

`docs/技术方案.md` §11 (loss matrix and landings), `docs/模块盘点/lowering-pi.md`, `spikes/` (upstream behaviour probes) — in Chinese, at the repository root.

MIT © 2026 NewRate Limited.
