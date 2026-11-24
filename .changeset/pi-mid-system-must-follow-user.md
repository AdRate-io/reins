---
"@reinsjs/lowering-pi": patch
---

On the Anthropic line, a mid-conversation `system_note` whose place on the wire would not follow a user turn is now wrapped in a `<system_note>` tag and sent with the `user` role, declared `lossy` (`user-role`). Previously it was still sent as a `system` message right after an assistant message (for example when a run starts with only a note after the model's last plain-text answer, or a note sits between two assistant messages) and declared `exact`; Anthropic rejects that shape with a 400, and since the timeline is replayed every turn the session kept failing until a new user message arrived. This matches `@reinsjs/lowering-fetch`.

The check runs against the messages pi-ai actually sends: a whitespace-only user message (which pi-ai drops on the Anthropic line) no longer counts as the user turn a note may follow.
