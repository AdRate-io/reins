---
"@reinsjs/server": minor
"@reinsjs/ui-agui": minor
"@reinsjs/agent": patch
---

HTTP mid-run input. `createAgentHandler(agent, { midRunInput: true })` queues a user message that arrives while the session's run is active in this process — sent by the run's own principal, without `resume` / `decisions` — into a per-run in-memory mailbox and answers `202 { status: "queued", sessionId, deliveryId }`; the run writes it into the timeline before its next model call. New request field `deliveryId` (also accepted when a `POST` starts a run) becomes the message's `provenance.ref` with `source: USER_DELIVERY_SOURCE`; delivery is judged by that event appearing in the timeline. Undelivered messages are dropped when the run ends; other cases still answer `409`, a full mailbox (16 waiting) answers `429 mailbox_full`. `@reinsjs/ui-agui` now copies a user message's `provenance` onto its `TEXT_MESSAGE_START` as `metadata.reins.provenance`; other events are unchanged.
