---
"@reinsjs/ui-agui": patch
---

A tool call's `parentMessageId` now only points at assistant text from the same model response. Before, it was reset only by a user message, so when a later turn of the same run (or a run resumed after approval) emitted a tool call without text, the call was attached to the previous turn's message: clients that build `messages` from the stream (CopilotKit, `@ag-ui/client`) merged it into the earlier bubble, ahead of that turn's tool results. Any event that is not model output (tool result, user message, pause or resume marker) now ends the response.
