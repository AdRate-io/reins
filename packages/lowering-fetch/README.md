# @reinsjs/lowering-fetch

A zero-dependency lowering layer for [reins](../../README.md): timeline events → provider wire protocol → event drafts, using nothing but `fetch` and a hand-written SSE parser. No provider SDK, no `node:*`, the same code on Node, Workers, Deno and Bun.

Three wire protocols: **OpenAI Chat Completions** (the front door of the OpenAI-compatible ecosystem: DeepSeek, Qwen, vLLM, gateways), **Anthropic Messages** (mid-conversation system placement, signed thinking replay, explicit cache breakpoints) and **OpenAI Responses** (stateless `store: false`, encrypted reasoning replay, developer messages anywhere).

```bash
pnpm add @reinsjs/lowering-fetch
```

```ts
import { anthropic, anthropicMessages, deepseek, openai, openaiChat, openaiResponses, chatCompletions } from "@reinsjs/lowering-fetch"
import { createAgent } from "@reinsjs/agent"

const opus = anthropic("claude-opus-5", { apiKey: process.env.ANTHROPIC_API_KEY! })
const ds = deepseek("deepseek-flash", { apiKey: process.env.DEEPSEEK_API_KEY! })
const gpt = openai("gpt-5-mini", { apiKey: process.env.OPENAI_API_KEY!, requestOptions: { reasoning: { effort: "low", summary: "auto" } } })
const mini = openaiChat("gpt-4o-mini", { apiKey: process.env.OPENAI_API_KEY! })
// any Anthropic-protocol endpoint (DeepSeek's compatible port, a gateway)
const dsClaude = anthropicMessages("deepseek-v4-flash", {
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com/anthropic",
  apiKey: process.env.DEEPSEEK_API_KEY!,
  reasoning: true,
  midConversationSystem: true,
})
const qwen = chatCompletions("qwen-max", {
  provider: "qwen",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: process.env.DASHSCOPE_API_KEY!,
  contextWindow: 128_000,
})

export const agent = createAgent({ model: ds, store, tools })
```

Each factory returns a `BoundModel = { model, lowering }`. `apiKey` is required and never read from the environment. For several models on one lowering instance, construct `FetchLowering` yourself and pass `models`.

## Choosing between `@reinsjs/lowering-fetch` and `@reinsjs/lowering-pi`

Both implement the same `Lowering` interface from `@reinsjs/core` and both declare every landing in a `LOSS_MATRIX`; `createAgent` does not care which one you pass. They coexist on purpose — pick per host, not per project.

| | `@reinsjs/lowering-fetch` | `@reinsjs/lowering-pi` |
| --- | --- | --- |
| Protocols | OpenAI Chat Completions, Anthropic Messages, OpenAI Responses | Anthropic Messages, OpenAI Responses |
| Dependencies | `@reinsjs/core` only (≈90 KB of ESM) | `pi-ai` and its ten dependencies (≈65 MB installed) |
| Request body | `payload.body` is what is sent | pre-rewrite shape; the real body is produced in pi-ai's `onPayload` hook |
| Mid-conversation `system` on Anthropic | placed by the encoder | placed by rewriting pi-ai's payload |
| Unsigned thinking | `dropped` (declared) | may fall back to visible text |
| Model table | a minimal built-in table you override per model | pi-ai's table, maintained upstream |
| Runtime | verified on Cloudflare workerd at the strictest tier (2023 compatibility date, no `nodejs_compat`), all three protocols against live providers | verified on workerd at the same tier, both protocols |

**Start with `lowering-fetch`** for a new host: it covers everything `lowering-pi` covers plus the OpenAI-compatible ecosystem, ships nothing but this package, and the request you debug is the request that was sent. Stay on `lowering-pi` when you already run on it (there is nothing to migrate for), or when you want the provider table and new wire-protocol features to arrive through pi-ai rather than through this package. Events written by one layer replay through the other: `replay.thinkingSignature` uses the same shape on both, so switching does not invalidate a stored timeline.

## Runtime

No `node:*`, no `process`, no `Buffer` — the same `dist/index.js` runs on Node ≥ 22 and on Cloudflare Workers with a 2023 `compatibility_date` and no compatibility flags (`spikes/edge-runtime-check`, tier "最严档": module load, a byte-sliced SSE stream against a local fake endpoint, and one live request per protocol). Bun / Deno / Vercel Edge are expected to work for the same reason but have not been run. Bring your own `fetch` through `FetchLoweringOptions.fetch` when the host needs a proxy or a Workers service binding.

## Options

| option | meaning |
| --- | --- |
| `apiKey` | required; use `auth: "none"` when the credential lives in `headers` (Cloudflare AI Gateway's `cf-aig-authorization`) |
| `baseUrl` | protocol root; `/chat/completions` (OpenAI: `…/v1`, DeepSeek: the bare host), `/messages` (Anthropic: `…/v1`) or `/responses` (OpenAI: `…/v1`) is appended |
| `contextWindow`, `maxOutputTokens`, `reasoning`, `images`, `cost`, `midConversationSystem` | override the built-in table; unknown models start from conservative defaults (128k / 16k / no reasoning / no images) |
| `chat.reasoningContent` | DeepSeek dialect: replay `reasoning_content` (on by default in `deepseek()`, see below) |
| `anthropic.betas` | values for the `anthropic-beta` header; sent only when set (mid-conversation system needs none) |
| `anthropic.cacheBreakpoints`, `anthropic.cacheTtl`, `anthropic.midSystemCacheBreakpoint` | explicit cache breakpoints on Anthropic (default on, 5 min); what to do when a note ends the request — `"automatic"` (default, top-level `cache_control`), `"previous-user"`, `"drop"` |
| `responses.systemRole` | role for the system prompt and notes on Responses: default `developer` for reasoning models, `system` otherwise; pin it for an upstream that rejects one of them |
| `responses.encryptedReasoning` | default on for reasoning models: `include: ["reasoning.encrypted_content"]` is always sent so reasoning items can be replayed under `store: false`; off for upstreams that reject `include` (then `thinkingReplay` reports `false`) |
| `requestOptions` | spread into the body (`max_tokens`, `temperature`, `thinking`, OpenAI's `parallel_tool_calls`, Responses' `reasoning` / `max_output_tokens` / `prompt_cache_key`…); `messages` / `input` / `tools` / `system` / `model` / `stream` / `store` / `previous_response_id` cannot be overridden. On Anthropic `max_tokens` defaults to the model's `maxOutputTokens` and `thinking` is left to you (Opus 5+ defaults to adaptive server-side; Haiku 4.5 still needs `budget_tokens`); on Responses `reasoning` is likewise yours (gpt-5 defaults to `medium`, gpt-5.1+ to `none`) |
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

## How events land on Anthropic Messages

Declared in `LOSS_MATRIX["anthropic-messages"]`, cell for cell comparable with `@reinsjs/lowering-pi`.

- `system_note` → a mid-conversation `{ role: "system" }` message on model families that accept it (Fable 5.x / Mythos 5.x / Opus 5 / Opus 4.8, or `midConversationSystem: true`). The provider requires such a message to follow a `user` turn and be followed by an `assistant` turn or end the request, so notes are held and emitted right before the next assistant turn (or at the end); when that slot follows an assistant turn — or the note would be the first message — the note goes out as a framed `user` text (`lossy(user-role)`). Other models always get the framed text.
- Tool results and anything moved after them (a user message that arrived while results were pending) share one `user` message, so `tool_result` blocks directly follow the `tool_use` turn. `is_error` is carried natively.
- **Thinking** is replayed only when the event carries a `signature` from the same provider and API (`thinking` / `redacted_thinking` blocks); unsigned thinking (an interrupted stream) or thinking from another provider is `dropped` and declared — it is not turned into visible text. Empty-text thinking blocks with a signature (`display: "omitted"`) are kept and replayed.
- **Cache breakpoints**: one on the last system block, one on the last tool, one on the last block of the last `user` message. When a note is the last message, the conversation breakpoint becomes a top-level `cache_control` (measured on par with no injection). Never more than four in total.
- Usage: `input_tokens` is already the uncached count; `cache_read_input_tokens` / `cache_creation_input_tokens` map to `cacheRead` / `cacheWrite`. `stop_reason: "refusal"` becomes a non-retryable `error` carrying `stop_details`.

## How events land on OpenAI Responses

Declared in `LOSS_MATRIX["openai-responses"]`, cell for cell comparable with `@reinsjs/lowering-pi`.

- **Stateless by construction.** Every request carries the whole history in `input`; `store: false` is forced and a `previous_response_id` in `requestOptions` is dropped — the timeline is the only source of truth, OpenAI's server-side conversation state is never relied on.
- The system prompt and `system_note` are `developer` messages (reasoning models) or `system` messages (others) at any position in `input` — no placement rules, always `exact`. `compaction` is a framed `user` text (`lossy`).
- **Reasoning**: reasoning models always request `include: ["reasoning.encrypted_content"]`; each reasoning item is stored whole in the event's `replay.thinkingSignature` and replayed verbatim (the provider verifies the encrypted payload — a forged one is a 400). Items without `encrypted_content` (an interrupted stream, `include` refused) or from another provider are `dropped` and declared, never turned into text. Reasoning items with an encrypted payload but no summary are kept as empty-text thinking events so the next turn can replay them.
- Assistant text becomes a `type: "message"` item per text block, replaying the provider's `msg_` id (`replay.textSignature`, lowering-pi's JSON form is accepted too) or a generated one. Tool calls are `function_call` items: `call_id` is the event's `toolCallId`, the `fc_` item id lives in `replay.itemId` and is replayed only for the same model (OpenAI validates the pairing of `fc_` and `rs_` items); `arguments` is a JSON string, so non-object arguments need no wrapping. Tools are sent with `strict: false`.
- Tool results are `function_call_output` items matched by `call_id`: a string when text-only, an array of `input_text` / `input_image` blocks when the result has images and the model accepts them; `isError` has no flag on this protocol and is expressed as a `[tool error]` prefix (`lossy`).
- Usage: `input_tokens` includes cached and cache-write tokens, so `input` is `input_tokens − cached_tokens − cache_write_tokens`, with the two mapped to `cacheRead` / `cacheWrite`. `status: "incomplete"` with `max_output_tokens` is `length`; with `content_filter` a non-retryable `error`; `response.failed` and `error` frames are errors carrying the provider's code and message. Automatic prefix caching is best-effort on OpenAI's side; pass `prompt_cache_key` in `requestOptions` to improve hit rates.
- Built-in table: the gpt-5 family (5.5 / 5.4 / 5.4-mini / 5.2 / 5.1 / 5 / 5-mini / 5-nano), o3 / o4-mini and gpt-4.1 / 4.1-mini / 4o-mini on Responses; the same OpenAI ids also exist as Chat Completions entries, which `openaiChat()` picks by protocol. A bare `{ provider: "openai", id }` on a `FetchLowering` you construct yourself resolves to Responses.

## Errors and retries

Non-2xx responses throw `HttpError` with `status`, `headers` and the raw body (`"<status> <body>"`, the same shape the official SDKs use), so `runLoop`'s transient-failure rule applies unchanged: 408 / 409 / 429 / 5xx retry, everything else does not. Network failures propagate from `fetch` untouched.

## Documentation

`docs/技术方案.md` §11, `docs/模块盘点/lowering-fetch.md`, `spikes/f1-chat-live/`, `spikes/f2-anthropic-live/`, `spikes/f3-responses-live/` (live verification against DeepSeek and, through the Cloudflare AI Gateway, OpenAI and Anthropic) and `spikes/edge-runtime-check/` (Cloudflare workerd) — in Chinese, at the repository root.

MIT © 2026 NewRate Limited.
