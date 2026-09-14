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

The umbrella `reins` package already uses `aguiEncoding()` as the default for `createAgent(...).handler`.

## Mapping

| timeline | AG-UI |
| --- | --- |
| run start / `result` | `RUN_STARTED`, `RUN_FINISHED` (`outcome: success` or `interrupt` with one entry per `Interruption`, the full `RunResult` — including the signed `state` — in `result`), `RUN_ERROR` |
| `model_text` (+ streaming deltas) | `TEXT_MESSAGE_START` / `_CONTENT` / `_END` |
| `model_thinking` | `REASONING_*` |
| `tool_call`, `tool_result` | `TOOL_CALL_START` / `_ARGS` / `_END`, `TOOL_CALL_RESULT` |
| `user_message` | `MESSAGES_SNAPSHOT`-compatible user message |
| everything else (`system_note`, `compaction`, `approval_*`, `budget_usage`, `run_paused` …) | `CUSTOM` with `name` = event type and the event as `value` |

Interrupts carry what a UI needs to answer them: an `approval` has `toolCallId`, the request summary and the policy id; a `subagent` interrupt (a nested agent waiting for approval) has `metadata.childSessionId` plus the child's own interruptions — send the decision back with `sessionId: childSessionId`.

`mapEvent` / `AGUI_MAPPING` are exported for hosts that want the pure per-event translation without the streaming encoder. `@reinsjs/ui-agui/demo/index.html` is a dependency-free page that talks to `@reinsjs/server` and renders the stream; `examples/minimal` serves it.

## Documentation

`docs/模块盘点/ui-agui.md` — in Chinese, at the repository root.

MIT © 2026 NewRate Limited.
