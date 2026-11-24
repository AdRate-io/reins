---
"@reinsjs/core": minor
"@reinsjs/adapter-tanstack-ai": minor
---

`runLoop` no longer yields the new session's opening events on a handoff; it yields only events of its own `sessionId`. Before, the summary note and trigger message written into the new session were yielded to the old session's consumer, so `createAgentHandler` streamed them on the old session's SSE stream (ids going back to 1, 2 before the old session's `run_ended`), AG-UI clients showed the trigger message in the old thread, a reconnect with that `Last-Event-ID` replayed most of the old session, and `onEvent` reported them under the old `sessionId`. The opening is still written to the log; read it from `toSessionId`. The TanStack adapter likewise no longer passes them to `onEvent`.
