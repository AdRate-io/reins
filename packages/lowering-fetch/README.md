# @reinsjs/lowering-fetch

A zero-dependency lowering layer for [reins](../../README.md): timeline events → provider wire protocol → event drafts, using nothing but `fetch` and a hand-written SSE parser. No provider SDK, no `node:*`, the same code on Node, Workers, Deno and Bun.

Implemented today: **OpenAI Chat Completions** (the front door of the OpenAI-compatible ecosystem: DeepSeek, Qwen, vLLM, gateways). Anthropic Messages and OpenAI Responses follow; until then use [`@reinsjs/lowering-pi`](../lowering-pi/README.md) for those two.

```bash
pnpm add @reinsjs/lowering-fetch
```

```ts
import { deepseek, openaiChat, chatCompletions } from "@reinsjs/lowering-fetch"
import { createAgent } from "@reinsjs/agent"

const ds = deepseek("deepseek-flash", { apiKey: process.env.DEEPSEEK_API_KEY! })
const mini = openaiChat("gpt-4o-mini", { apiKey: process.env.OPENAI_API_KEY! })
const qwen = chatCompletions("qwen-max", {
  provider: "qwen",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: process.env.DASHSCOPE_API_KEY!,
  contextWindow: 128_000,
})

export const agent = createAgent({ model: ds, store, tools })
```

Each factory returns a `BoundModel = { model, lowering }`. `apiKey` is required and never read from the environment. For several models on one lowering instance, construct `FetchLowering` yourself and pass `models`.

## What you get that pi-ai cannot give

- **The request body you inspect is the request body that is sent.** `LoweredRequest.payload.body` is POSTed as is — no second-pass rewrite, so a 400 is debugged by looking at the payload.
- **Install size**: this package plus `@reinsjs/core`, nothing else.
- **Request shaping is ours**, which is what the roadmap's provider-native lazy tools (tool search / deferred loading) need.

## Options

| option | meaning |
| --- | --- |
| `apiKey` | required; use `auth: "none"` when the credential lives in `headers` (Cloudflare AI Gateway's `cf-aig-authorization`) |
| `baseUrl` | protocol root; `/chat/completions` is appended (OpenAI: `…/v1`, DeepSeek: the bare host) |
| `contextWindow`, `maxOutputTokens`, `reasoning`, `images`, `cost`, `midConversationSystem` | override the built-in table; unknown models start from conservative defaults (128k / 16k / no reasoning / no images) |
| `chat.reasoningContent` | DeepSeek dialect: replay `reasoning_content` (on by default in `deepseek()`, see below) |
| `requestOptions` | spread into the body (`max_tokens`, `temperature`, DeepSeek's `thinking`, OpenAI's `parallel_tool_calls`…); `messages` / `tools` / `model` / `stream` cannot be overridden |
| `timeoutMs` | whole-request deadline including the stream, default 600 000; a timeout is a retryable error, a host `signal` abort is `aborted` |
| `trustMarkers` | default on: tool output is wrapped in `<untrusted source="tool:…">` in the request; the log keeps the original |

## How events land on Chat Completions

Every landing is declared in `LOSS_MATRIX["openai-chat"]` and asserted by tests — nothing is dropped silently.

- `system_note` → a mid-conversation `system` message (`exact`; verified on OpenAI and DeepSeek). Set `midConversationSystem: false` for an upstream that rejects it and the note goes out as a framed `user` message (`lossy`).
- A user message or note that arrives while tool results are still pending is moved after them on the wire (`tool` messages must directly follow the `assistant` that called them); the user message is recorded `lossy(user)`, the log order is untouched.
- **Thinking**: Chat Completions has no replay slot (no signature, no encrypted item). On the official API thinking events are `dropped`. With `chat.reasoningContent` (DeepSeek) they are replayed as `reasoning_content` — and DeepSeek *requires* the field on every historical assistant message once `tools` is present (400 otherwise), so the layer always sends it, empty when there is nothing to replay.
- One turn with several text blocks is merged into one `content` string (`lossy(merged-text)`); `tool` messages carry text only, images become a placeholder (`lossy`); `isError` has no flag on this protocol and is expressed as a `[tool error]` prefix (`lossy`).
- No explicit cache breakpoints exist on this protocol; provider-side automatic prefix caching applies and `cached_tokens` is reported as `cacheRead`.
- Usage follows core semantics: `input` is the uncached prompt count. `costUsd` uses the built-in price table (DeepSeek: peak rates, an upper bound).

## Errors and retries

Non-2xx responses throw `HttpError` with `status`, `headers` and the raw body (`"<status> <body>"`, the same shape the official SDKs use), so `runLoop`'s transient-failure rule applies unchanged: 408 / 409 / 429 / 5xx retry, everything else does not. Network failures propagate from `fetch` untouched.

## Documentation

`docs/技术方案.md` §11, `docs/模块盘点/lowering-fetch.md`, `spikes/f1-chat-live/` (live verification against DeepSeek and the Cloudflare AI Gateway) — in Chinese, at the repository root.

MIT © 2026 NewRate Limited.
