---
"@reinsjs/core": minor
"@reinsjs/store-pg": minor
"@reinsjs/adapter-tanstack-ai": minor
"@reinsjs/server": minor
"@reinsjs/agent": minor
"@reinsjs/ui-agui": minor
"@reinsjs/lowering-fetch": patch
"@reinsjs/lowering-pi": patch
---

Session run status. Every `runLoop` run now starts with `core.tools_bound` (carrying `marksEnd: true`) and ends with exactly one end marker: `core.run_paused` as before, or the new model-invisible `core.run_ended` with `status: "done" | "handoff" | "error"`. `core.run_paused` gains `awaiting` (the pending calls waiting on an approval — with `requestedAt` —, a client tool or a sub-agent) and `stopped: true` for a user stop. A `core.error` the loop retries past, or one recorded for a throwing `pullInput`, gets no `run_ended`; an error that ends the run is written together with its `run_ended`.

`runStatusOf({ held, lastMarker })` classifies a session as running / paused / done / handoff / error / interrupted / idle / unknown from a lease flag and `lastRunMarker(timeline)`. `@reinsjs/store-pg` adds `pgRunStates(client, sessionIds)`: one SQL statement reads the leases and each session's last marker, so a session list never sees a gap between "lease released" and "outcome written". "Running" is only known for runs started through the server handler with a lease registry (`createAgent` + `pgStores`).

Log shape changes: on a resumed run `core.tools_bound` now comes before `core.run_resumed` / `core.approval_decision`, and `RunResult.lastSeq` of a done or handoff run points at its `run_ended`. Live streams carry one more event (a `CUSTOM` frame in AG-UI). The TanStack adapter writes `run_ended` too, but its `tools_bound` carries no `marksEnd` and its `run_paused` no `awaiting` / `stopped`. Lowerings drop `run_ended` like other operational events.

**Rolling upgrade:** `@reinsjs/core` 0.13 and earlier reject sessions that contain `core.run_ended` (unknown event type). Upgrade every instance to the same core version at once, and do not roll back past 0.14 once such sessions exist. Sessions whose last run finished before the upgrade read `unknown`.
