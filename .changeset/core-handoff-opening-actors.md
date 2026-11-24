---
"@reinsjs/core": minor
"@reinsjs/adapter-tanstack-ai": patch
---

Handoff now records who really wrote each opening event of the new session. The summary note used to be a host note (`actor: "host"`, system trust) and the trigger message a user message (`actor: "user"`, principal trust), even when the model wrote both — so a `triggerMessage` the model was talked into by a tool result showed up in the new session as the user's own instruction. Now the summary is recorded as `intent.by` (default `"model"`), and so is the trigger message unless it repeats one of the old session's `actor: "user"` messages word for word, in which case it stays the user's (with the original's trust) and `provenance.ref` points at that message. The summary and self-written trigger messages carry `provenance: { source: "handoff", ref: <core.handoff event id> }`. The shape is built by the new export `handoffOpeningDrafts`, shared by `runLoop` and the TanStack adapter. Event types, payloads and what the model sees are unchanged; code that filtered the new session by `actor` (for example "the user's first message") should read the event type or `provenance` instead.
