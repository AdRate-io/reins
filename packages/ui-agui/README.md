# @reinsjs/ui-agui

Timeline events → [AG-UI](https://docs.ag-ui.com) protocol events. reins does not invent a front-end protocol for what the agent streams back: this package turns the response stream into AG-UI events, so a UI built on AG-UI's event and message model (CopilotKit and friends) can render a reins agent. It translates the **response only** — requests keep `@reinsjs/server`'s body shape, so a stock AG-UI client needs a thin request adapter (see "Requests" below). Zero runtime dependencies; every emitted event is validated against `@ag-ui/core`'s official schema in the tests.

```bash
pnpm add @reinsjs/ui-agui
```

```ts
import { aguiEncoding } from "@reinsjs/ui-agui"
import { createAgentHandler } from "@reinsjs/server"

// `agentDefinition` is the AgentDefinition (loop config); with `createAgent()` that is `agent.definition`
export const POST = createAgentHandler(agentDefinition, { encode: aguiEncoding() })
```

The umbrella `@reinsjs/agent` package already uses `aguiEncoding()` as the default for `createAgent(...).handler`.

## Requests

The handler does not read AG-UI's `RunAgentInput` (`threadId`, `messages`, `tools`, `state`, `forwardedProps`, AG-UI `resume`). Unknown fields are ignored, so pointing an unmodified `HttpAgent` at the handler starts a new session on every request with no user input. Map the request yourself, in a custom agent on the client or a small route in front of the handler:

| AG-UI client side | reins request body (`@reinsjs/server`) |
| --- | --- |
| `threadId` | `sessionId` — omit it on the first request; the session id comes back as `RUN_STARTED.threadId` and in the `X-Reins-Session` header |
| the newest user message in `messages` | `input` (a string or content parts); the server keeps the history, so do not resend earlier messages |
| answering an `interrupt` outcome | `resume`: the `state` from `RUN_FINISHED.result`, plus `decisions: [{ toolCallId, approved, by }]` (add `sessionId: childSessionId` for a `subagent` interrupt) |
| a frontend (client-side) tool result | `input: { type: "core.tool_result", payload: { toolCallId, content } }` |

See the request body and status codes in the `@reinsjs/server` README; `demo/index.html` is a working client that sends this shape.

## Mapping

| timeline | AG-UI |
| --- | --- |
| run start / `result` | `RUN_STARTED`, `RUN_FINISHED` (`outcome: success` or `interrupt` with one entry per `Interruption` — a `budget` / `host` entry carries the socket's pause code in `metadata.code` when it has one, the full `RunResult` — including the signed `state` — in `result`), `RUN_ERROR`. A replay-only stream ends with `RUN_FINISHED` (`outcome: success`, `result: { status: "replayed", sessionId, lastSeq }`); when the session is paused at its last event the `result` also carries the signed `state` to resume with — the latest pause of any reason, so show an approval card only for ids in `state.pendingToolCallIds` that have a `core.approval_request` |
| `model_text` (+ streaming deltas) | `TEXT_MESSAGE_START` / `_CONTENT` / `_END` |
| `model_thinking` | `REASONING_*` |
| `tool_call`, `tool_result` | `TOOL_CALL_START` / `_ARGS` / `_END`, `TOOL_CALL_RESULT` |
| `user_message` | `TEXT_MESSAGE_START` (`role: "user"`) / `_CONTENT` / `_END` |
| everything else (`system_note`, `compaction`, `approval_*`, `budget_usage`, `run_paused`, `run_ended` …) | `CUSTOM` with `name` = event type and the event as `value` |

Interrupts carry what a UI needs to answer them: an `approval` has `toolCallId`, the request summary and the policy id; a `subagent` interrupt (a nested agent waiting for approval) has `metadata.childSessionId` plus the child's own interruptions — send the decision back with `sessionId: childSessionId`.

Every event translated from the timeline carries `metadata.reins` with the timeline `seq`, `eventId` and `type` (plus `dropped` when content had no AG-UI slot). A message streamed from deltas has a temporary `messageId`; its `_START` / `_CONTENT` frames carry no `metadata.reins`, and its `_END` frame carries it once the committed event whose text matches the streamed text arrives — each streamed segment is sent once. When the texts do not match (a redacted-thinking placeholder, a block upstream never committed) the committed event is sent in full under its event id: a duplicate rather than lost or mislabelled content. Lowerings commit a response only after it has fully streamed, so a reasoning message and a text message can be open at the same time; every message is ended before `RUN_FINISHED`, and a streamed block that no committed event claims is ended without `metadata.reins`. A user message's `TEXT_MESSAGE_START` and `TEXT_MESSAGE_END` carry the same full `metadata.reins` — AG-UI clients merge a message's metadata key by key with the last write winning, so anything only on `_START` would be replaced by `_END`. That includes the event's `provenance` when it has one — that is how a client sees the `deliveryId` of a message it sent while a run was in progress (`midRunInput` in `@reinsjs/server`). Other events do not copy `provenance`; `CUSTOM` events already hold the whole event in `value`.

## Images and other media

AG-UI's streaming events carry text only, so the message text keeps a placeholder such as `[image image/png]`. When a user message or a tool result contains an image, video or audio part, its `metadata.reins.parts` (on a user message's `TEXT_MESSAGE_START` / `_END`, on `TOOL_CALL_RESULT`) lists the content in its original order without any bytes: `{ type: "text", text }`, `{ type: "image", mime, blobId }` for an image stored by reference, and `{ type: "image" | "video" | "audio", mime }` for inline media. Render the message from `parts` when it is present and from the text otherwise. `displayPartsOf(content)` is the same function, exported for hosts that write their own encoder.

A `blobId` does not grant access by itself. Serve images from your own route (see "Images by reference" in `@reinsjs/server`) and keep all three checks there: your session check, `blobUsableBy`, and a raster-only `meta.mime` allowlist with `nosniff` (an SVG opened from your origin runs its scripts) — `blobUsableBy` also accepts the session's own spilled tool results, whose ids appear in the same `metadata.reins`. The id now reaches the browser, so a custom `BlobStore` should not use storage paths or signed URLs as ids. Fall back to the placeholder when there is no `blobId` (inline media) or the route answers 404 (a blob removed by your retention policy), and treat the id as opaque: `encodeURIComponent` it in a URL.

`mapEvent` / `AGUI_MAPPING` are exported for hosts that want the pure per-event translation without the streaming encoder. `@reinsjs/ui-agui/demo/index.html` is a dependency-free page that talks to `@reinsjs/server` and renders the stream; `examples/minimal` serves it.

## Documentation

`docs/系统全景图_模块盘点/ui-agui.md` — in Chinese, at the repository root.

MIT © 2026 NewRate Limited.
