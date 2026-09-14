---
"@reinsjs/server": minor
---

New handler option `onEvent(event, { sessionId, principal, request })` — a side-channel observer for runs started over HTTP. It is called once per event the run appends, in `seq` order, with the resolved `principal` and the originating `Request`, so hosts can attach trace ids and user ids to their own logs. It observes and does not edit; only live events are reported (replays are read back from the log and skipped); the run is never slowed or broken by it — events reach SSE subscribers first, async return values are chained in order without blocking the loop, and a failure is reported once per run through the new `warn` option (default `console.warn`). The run's `result` frame and `ActiveRun.done` wait for the chain to settle so a Worker's `waitUntil` covers the last observation. In-process, `agent.run()` is already an async generator of events and needs no hook.
