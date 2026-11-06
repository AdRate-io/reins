# @reinsjs/ui-agui

Timeline events → [AG-UI](https://docs.ag-ui.com) protocol events. reins does not invent a front-end protocol; this package makes any AG-UI client (CopilotKit and friends) a working UI for a reins agent. Zero runtime dependencies; every emitted event is validated against `@ag-ui/core`'s official schema in the tests.

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

## Mapping

| timeline | AG-UI |
| --- | --- |
| run start / `result` | `RUN_STARTED`, `RUN_FINISHED` (`outcome: success` or `interrupt` with one entry per `Interruption`, the full `RunResult` — including the signed `state` — in `result`), `RUN_ERROR`. A replay-only stream ends with `RUN_FINISHED` (`outcome: success`, `result: { status: "replayed", sessionId, lastSeq }`); when the session is paused at its last event the `result` also carries the signed `state` to resume with — the latest pause of any reason, so show an approval card only for ids in `state.pendingToolCallIds` that have a `core.approval_request` |
| `model_text` (+ streaming deltas) | `TEXT_MESSAGE_START` / `_CONTENT` / `_END` |
| `model_thinking` | `REASONING_*` |
| `tool_call`, `tool_result` | `TOOL_CALL_START` / `_ARGS` / `_END`, `TOOL_CALL_RESULT` |
| `user_message` | `MESSAGES_SNAPSHOT`-compatible user message |
| everything else (`system_note`, `compaction`, `approval_*`, `budget_usage`, `run_paused` …) | `CUSTOM` with `name` = event type and the event as `value` |

Interrupts carry what a UI needs to answer them: an `approval` has `toolCallId`, the request summary and the policy id; a `subagent` interrupt (a nested agent waiting for approval) has `metadata.childSessionId` plus the child's own interruptions — send the decision back with `sessionId: childSessionId`.

Every event translated from the timeline carries `metadata.reins` with the timeline `seq`, `eventId` and `type` (plus `dropped` when content had no AG-UI slot). A message streamed from deltas has a temporary `messageId`; its `_START` / `_CONTENT` frames carry no `metadata.reins`, and its `_END` frame carries it once the committed event whose text matches the streamed text arrives — each streamed segment is sent once. When the texts do not match (a redacted-thinking placeholder, a block upstream never committed) the committed event is sent in full under its event id: a duplicate rather than lost or mislabelled content. Lowerings commit a response only after it has fully streamed, so a reasoning message and a text message can be open at the same time; every message is ended before `RUN_FINISHED`, and a streamed block that no committed event claims is ended without `metadata.reins`. A user message's `TEXT_MESSAGE_START` also carries the event's `provenance` when it has one — that is how a client sees the `deliveryId` of a message it sent while a run was in progress (`midRunInput` in `@reinsjs/server`). Other events do not copy `provenance`; `CUSTOM` events already hold the whole event in `value`.

`mapEvent` / `AGUI_MAPPING` are exported for hosts that want the pure per-event translation without the streaming encoder. `@reinsjs/ui-agui/demo/index.html` is a dependency-free page that talks to `@reinsjs/server` and renders the stream; `examples/minimal` serves it.

## Documentation

`docs/系统全景图_模块盘点/ui-agui.md` — in Chinese, at the repository root.

MIT © 2026 NewRate Limited.
