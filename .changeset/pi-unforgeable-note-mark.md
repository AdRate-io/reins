---
"@reinsjs/lowering-pi": minor
---

A user message (or any user text) that starts with `[[reins:system_note]]` is no longer promoted to a `system` / `developer` message. Previously the internal marker that tags mid-conversation `system_note` messages was a fixed string, so user text beginning with it was rewritten into a system message on the wire: on OpenAI Responses the user's words arrived with developer authority, and on Anthropic a session whose first message carried it got a 400 on every request. `PiAiLowering` now tags notes with a fresh random marker per request (`newSystemNoteMark()`), carried to `stream` in the new optional `PiLoweredPayload.systemNoteMark`; user text is always sent as written with the `user` role.

`markSystemNote`, `rewriteAnthropicPayload`, `rewriteOpenAIResponsesPayload`, `rewritePayload` and `eventsToContext` accept the marker as an optional argument (`mark` / `systemNoteMark`); without it they keep the fixed `SYSTEM_NOTE_MARK`, which is only safe when the caller guarantees user text cannot start with it.
